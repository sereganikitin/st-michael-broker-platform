#!/usr/bin/env python3
"""Create only the absent operation lock after complete metadata-only audits.

Run as root for /proc visibility; the one file is created with the SSH caller's
effective UID and mode 0600. Never truncate, replace, chmod, chown or unlink it.
No process arguments/environment, database rows or file contents are inspected.
"""
import fcntl
import json
import os
import re
import stat
import sys

LOCK_PATH = "/tmp/st-michael-production-deploy.lock"
CLI_NAMES = {"docker", "docker-compose", "docker-buildx", "buildx", "buildctl"}


class Refused(Exception):
    pass


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode), info.st_nlink, info.st_size)


def lock_state():
    try:
        info = os.lstat(LOCK_PATH)
    except FileNotFoundError:
        return "missing", None
    if stat.S_ISLNK(info.st_mode):
        return "symlink", info
    if not stat.S_ISREG(info.st_mode):
        return "nonregular", info
    return "regular", info


def physical_tmp():
    info = os.lstat("/tmp")
    if not stat.S_ISDIR(info.st_mode) or os.path.realpath("/tmp") != "/tmp" or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o1777:
        raise Refused("TMP_NOT_PHYSICAL_STICKY_DIRECTORY")
    return identity(info)[:4]


def read_bounded(path, limit):
    with open(path, "r", encoding="ascii", errors="strict") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise Refused("PROC_METADATA_BOUND_EXCEEDED")
    return value


def proc_audit():
    # Every enumeration/read/permission/race error aborts the entire audit.
    # Iterating scandir live avoids observing our own already-closed directory
    # enumeration FD, which listdir(/proc/self/fd) can expose transiently.
    pids = sorted(name for name in os.listdir("/proc") if re.fullmatch(r"[1-9][0-9]*", name))
    if not pids or len(pids) > 10000:
        raise Refused("PROC_PID_BOUND_INVALID")
    deleted = set()
    deleted_owners = set()
    fd_count = 0
    cli_count = 0
    for pid in pids:
        comm = read_bounded("/proc/" + pid + "/comm", 128).strip()
        if not comm:
            raise Refused("PROC_COMM_INVALID")
        if comm in CLI_NAMES:
            cli_count += 1
        with os.scandir("/proc/" + pid + "/fd") as entries:
            per_pid = 0
            for entry in entries:
                if not re.fullmatch(r"[0-9]+", entry.name):
                    raise Refused("PROC_FD_INVALID")
                per_pid += 1
                fd_count += 1
                if per_pid > 65536 or fd_count > 250000:
                    raise Refused("PROC_FD_BOUND_EXCEEDED")
                target = os.readlink(entry.path)
                if target == LOCK_PATH + " (deleted)":
                    info = os.stat(entry.path)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 0:
                        raise Refused("DELETED_LOCK_METADATA_CHANGED")
                    deleted.add((os.major(info.st_dev), os.minor(info.st_dev), info.st_ino))
                    deleted_owners.add(pid)
    kernel_deleted_count = 0
    for line in read_bounded("/proc/locks", 8388608).splitlines():
        fields = line.split()
        if len(fields) > 1 and fields[1] == "->":
            del fields[1]
        if len(fields) != 8 or not re.fullmatch(r"[0-9]+:", fields[0]) or fields[1] not in {"FLOCK", "POSIX", "OFDLCK", "LEASE"}:
            raise Refused("PROC_LOCK_FORMAT_INVALID")
        if fields[2] not in {"ADVISORY", "MANDATORY", "ACTIVE", "BREAKING"} or fields[3] not in {"READ", "WRITE", "UNLCK"} or not re.fullmatch(r"-?[0-9]+", fields[4]):
            raise Refused("PROC_LOCK_FORMAT_INVALID")
        parts = fields[5].split(":")
        if len(parts) != 3 or not all(re.fullmatch(r"[0-9a-fA-F]+", item) for item in parts[:2]) or not re.fullmatch(r"[1-9][0-9]*", parts[2]):
            raise Refused("PROC_LOCK_FORMAT_INVALID")
        if not re.fullmatch(r"[0-9]+", fields[6]) or not re.fullmatch(r"[0-9]+|EOF", fields[7]):
            raise Refused("PROC_LOCK_FORMAT_INVALID")
        if (int(parts[0], 16), int(parts[1], 16), int(parts[2])) in deleted:
            kernel_deleted_count += 1
    if pids != sorted(name for name in os.listdir("/proc") if re.fullmatch(r"[1-9][0-9]*", name)):
        raise Refused("PROC_PID_INVENTORY_CHANGED")
    return {"proc_audit_complete": True, "process_count": len(pids), "active_docker_cli_count": cli_count,
            "deleted_lock_inode_count": len(deleted), "deleted_lock_owner_count": len(deleted_owners),
            "deleted_kernel_lock_count": kernel_deleted_count}


def assert_quiescent(facts):
    if not facts["proc_audit_complete"] or facts["active_docker_cli_count"] or facts["deleted_lock_inode_count"] or facts["deleted_lock_owner_count"] or facts["deleted_kernel_lock_count"]:
        raise Refused("OLD_LOCK_OWNER_OR_DOCKER_CLI_PRESENT")


def assert_file(fd, expected_uid):
    descriptor = os.fstat(fd)
    path = os.lstat(LOCK_PATH)
    if not stat.S_ISREG(path.st_mode) or not stat.S_ISREG(descriptor.st_mode) or identity(path) != identity(descriptor):
        raise Refused("LOCK_PATH_DESCRIPTOR_CHANGED")
    if descriptor.st_uid != expected_uid or stat.S_IMODE(descriptor.st_mode) != 0o600 or descriptor.st_nlink != 1 or descriptor.st_size != 0:
        raise Refused("LOCK_OWNER_MODE_LINK_OR_SIZE_INVALID")
    return identity(descriptor)


def initialize(expected_uid, emit):
    if os.getuid() != 0 or os.geteuid() != 0:
        raise Refused("ROOT_PROC_AUDIT_REQUIRED")
    tmp = physical_tmp()
    state, original = lock_state()
    emit({"initial_lock_state": state, "lock_created": False, "lock_certified": False})
    if state not in {"missing", "regular"}:
        raise Refused("EXISTING_LOCK_NOT_REGULAR")
    before = proc_audit()
    emit(before)
    assert_quiescent(before)
    if physical_tmp() != tmp or lock_state()[0] != state:
        raise Refused("LOCK_OR_TMP_STATE_CHANGED")
    if original is not None and identity(os.lstat(LOCK_PATH)) != identity(original):
        raise Refused("EXISTING_LOCK_INODE_CHANGED")
    fd = None
    created = False
    try:
        if state == "missing":
            # Temporary effective-UID drop creates the final file as the SSH
            # operator without a second chown/chmod mutation. Restore root only
            # for the second complete, read-only /proc audit.
            os.seteuid(expected_uid)
            try:
                fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                created = True
            finally:
                os.seteuid(0)
            emit({"lock_created": True, "lock_certified": False})
        else:
            fd = os.open(LOCK_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before_identity = assert_file(fd, expected_uid)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if assert_file(fd, expected_uid) != before_identity:
            raise Refused("LOCK_INODE_CHANGED_AT_FLOCK")
        after = proc_audit()
        emit(after)
        assert_quiescent(after)
        if physical_tmp() != tmp or assert_file(fd, expected_uid) != before_identity:
            raise Refused("LOCK_OR_TMP_CHANGED_AFTER_AUDIT")
        emit({"lock_created": created, "lock_certified": True, "lock_mode_0600": True,
              "lock_owned_by_operation_user": True, "lock_device": before_identity[0], "lock_inode": before_identity[1]})
    except Exception:
        emit({"lock_created": created, "lock_certified": False, "further_operations_blocked": True})
        raise
    finally:
        if fd is not None:
            os.close(fd)


def main(argv):
    emit = lambda value: print(json.dumps(value, sort_keys=True), flush=True)
    try:
        if len(argv) != 3 or argv[1] != "--initialize" or not re.fullmatch(r"0|[1-9][0-9]{0,9}", argv[2]) or int(argv[2]) > 2147483647:
            raise Refused("INPUT_INVALID")
        initialize(int(argv[2]), emit)
        return 0
    except Refused as error:
        emit({"lock_certified": False, "error": str(error), "further_operations_blocked": True})
    except Exception:
        # No raw OSError, pathname, process comm, traceback or exception text.
        emit({"lock_certified": False, "error": "LOCK_METADATA_AUDIT_FAILED", "further_operations_blocked": True})
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
