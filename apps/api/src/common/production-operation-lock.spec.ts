import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { parse } from "yaml";

describe("guarded initialization of the one production operation lock", () => {
  const root = resolve(__dirname, "../../../..");
  const helper = readFileSync(resolve(root, "scripts/initialize-production-operation-lock.py"), "utf8");
  const source = readFileSync(resolve(root, ".github/workflows/initialize-production-operation-lock.yml"), "utf8");
  const workflow = parse(source);
  const run = workflow.jobs.initialize.steps[1].run.replace(/\r\n/g, "\n");
  const remote = run.split("<<'REMOTE'\n")[1].split("\nREMOTE")[0];

  it("requires explicit realistic dispatch confirmation and pinned canonical/live source", () => {
    expect(workflow.on.workflow_dispatch.inputs.confirm_initialize.default).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.confirm_initialize.type).toBe("boolean");
    expect(run).toContain('.inputs.confirm_initialize == true or .inputs.confirm_initialize == "true"');
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.initialize.environment).toBe("production");
    expect(source).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(run).toContain('test "$master_sha" = "$EXPECTED_SHA"');
    expect(run).toContain("-o StrictHostKeyChecking=yes");
    expect(run).toContain('test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(remote).toContain('test "$(git rev-parse HEAD)" = "$expected_deployed_sha"');
    expect(remote).toContain('test "$(printf \'%s\' "$helper_base64" | base64 --decode | sha256sum');
    expect(remote).toContain("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'");
    expect(remote).toContain("sudo -n python3 -B - --initialize");
    expect(source).not.toContain("appleboy/");
  });

  it("never repairs/replaces/deletes files, images, data, backups or services", () => {
    const commands = remote.split("\n").filter((line: string) => !line.trim().startsWith("#")).join("\n");
    expect(commands).not.toMatch(/\b(rm|rmi|mv|cp|truncate|unlink|mktemp|mkdir|chmod|chown|tee|prune|vacuum)\b/);
    expect(commands).not.toMatch(/docker\s+(restart|start|stop|kill|run|build|pull|push|tag|compose)|image\s+(rm|prune|tag)/);
    expect(commands).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b|git\s+(fetch|reset|clean|checkout|pull|push)/);
    expect(remote).toContain('exec 9<"$lock_path"');
    expect(remote).not.toContain("exec 9>");
    expect(remote).toContain("flock -n 9");
    expect(remote).toContain("stat -Lc '%d:%i' -- /proc/$$/fd/9");
    expect(helper).toContain("os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600");
    expect(helper).not.toMatch(/os\.(unlink|remove|chmod|chown|replace)|O_TRUNC/);
    expect(helper).not.toContain("/cmdline");
    expect(helper).not.toMatch(/\/environ["']/);
    expect(helper).toContain('os.seteuid(expected_uid)');
    expect(helper).toContain('os.seteuid(0)');
  });

  it("parses actual full Bash without executing any workflow command", () => {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const result = spawnSync(bash, ["-n"], { input: run, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("executes only synthetic Python filesystem/proc/locking mocks", () => {
    const python = process.platform === "win32"
      ? "C:/Users/PC-OpenClaw/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
      : "python3";
    const program = `import base64, json, stat, sys, types
fake_fcntl = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda fd,flags: None)
sys.modules['fcntl'] = fake_fcntl
ns = {'__name__':'synthetic_fixture'}
exec(compile(base64.b64decode('${Buffer.from(helper).toString("base64")}'), 'reviewed_helper', 'exec'), ns)
def info(mode=stat.S_IFREG|0o600, uid=1000, inode=22, links=1, size=0):
  return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_ino=inode,st_dev=10,st_nlink=links,st_size=size)
class Model:
  O_RDONLY=0; O_RDWR=2; O_CREAT=64; O_EXCL=128; O_NOFOLLOW=131072; O_CLOEXEC=524288
  def __init__(self,scenario):
    self.scenario=scenario; self.euid=0; self.opens=[]; self.closed=[]; self.audits=0; self.path=types.SimpleNamespace(realpath=self.realpath)
    self.file=None if scenario.startswith('missing') or scenario in ['race_create','after_audit_failure','busy_new'] else info()
    if scenario=='symlink': self.file=info(stat.S_IFLNK|0o777)
    if scenario=='nonregular': self.file=info(stat.S_IFIFO|0o600)
    if scenario=='wrongmode': self.file=info(stat.S_IFREG|0o644)
    if scenario=='wrongowner': self.file=info(uid=0)
    if scenario=='hardlink': self.file=info(links=2)
    if scenario=='nonempty': self.file=info(size=1)
  def getuid(self): return 0
  def geteuid(self): return self.euid
  def seteuid(self,value): self.euid=value
  def lstat(self,path):
    if path=='/tmp': return info(stat.S_IFDIR|0o1777,0,2,2)
    assert path==ns['LOCK_PATH']
    if self.file is None: raise FileNotFoundError()
    return self.file
  def realpath(self,path): return path
  def open(self,path,flags,*mode):
    assert path==ns['LOCK_PATH']
    self.opens.append((flags,mode,self.euid))
    if self.scenario=='race_create': raise FileExistsError()
    if flags & self.O_CREAT:
      assert self.file is None and flags & self.O_EXCL and flags & self.O_NOFOLLOW and mode==(0o600,) and self.euid==1000
      self.file=info(uid=self.euid)
    return 40
  def fstat(self,fd):
    if self.scenario=='descriptor_mismatch': return info(inode=999)
    return self.file
  def close(self,fd): self.closed.append(fd)
  def audit(self):
    self.audits+=1
    if self.scenario in ['missing_permission','after_audit_failure'] and (self.scenario=='missing_permission' or self.audits==2): raise PermissionError('SYNTHETIC_PRIVATE_PATH')
    return {'proc_audit_complete':True,'process_count':1,'active_docker_cli_count':int(self.scenario=='missing_cli'),'deleted_lock_inode_count':int(self.scenario=='missing_deleted'),'deleted_lock_owner_count':int(self.scenario=='missing_deleted'),'deleted_kernel_lock_count':0}
results=[]
for scenario in ['missing_ok','regular','symlink','nonregular','wrongmode','wrongowner','hardlink','nonempty','descriptor_mismatch','missing_cli','missing_deleted','missing_permission','race_create','after_audit_failure','busy_new']:
  model=Model(scenario); outputs=[]
  ns['os']=model; ns['proc_audit']=model.audit
  def flock(fd,flags):
    assert flags==6
    if scenario=='busy_new': raise BlockingIOError()
  fake_fcntl.flock=flock
  success=True
  try: ns['initialize'](1000,outputs.append)
  except Exception: success=False
  creates=sum(bool(row[0]&64) for row in model.opens)
  if scenario in ['missing_ok','regular']:
    assert success and outputs[-1]['lock_certified'] and creates==(scenario=='missing_ok')
  else: assert not success
  if scenario in ['symlink','nonregular','missing_cli','missing_deleted','missing_permission']: assert not model.opens
  if scenario in ['after_audit_failure','busy_new']:
    assert model.file is not None and outputs[-1]['lock_created'] and not outputs[-1]['lock_certified'] and outputs[-1]['further_operations_blocked']
  if scenario!='race_create' and model.opens: assert model.closed==[40]
  assert model.euid==0
  results.append(scenario)
# Fresh namespace: audit real implementation against metadata-only proc mocks.
procns={'__name__':'synthetic_proc_fixture'}
exec(compile(base64.b64decode('${Buffer.from(helper).toString("base64")}'), 'reviewed_helper', 'exec'), procns)
class Entries:
  def __enter__(self): return iter([types.SimpleNamespace(name='9',path='/proc/123/fd/9')])
  def __exit__(self,*args): pass
class ProcModel:
  def __init__(self,scenario): self.scenario=scenario; self.lists=0
  def listdir(self,path):
    assert path=='/proc'; self.lists+=1
    return ['123','124'] if self.scenario=='churn' and self.lists>1 else ['123']
  def scandir(self,path):
    if self.scenario=='permission': raise PermissionError('SYNTHETIC_PRIVATE_PROC')
    return Entries()
  def readlink(self,path):
    if self.scenario=='fd_race': raise FileNotFoundError()
    return procns['LOCK_PATH']+' (deleted)' if self.scenario=='deleted' else 'socket:[12345]'
  def stat(self,path): return info(inode=22,links=0)
  def major(self,value): return 1
  def minor(self,value): return 2
for scenario in ['quiet','cli','deleted','permission','fd_race','churn','malformed_locks']:
  procns['os']=ProcModel(scenario)
  def read(path,limit):
    if path.endswith('/comm'): return 'docker' if scenario=='cli' else 'synthetic-python'
    assert path=='/proc/locks'
    return 'malformed' if scenario=='malformed_locks' else '1: FLOCK ADVISORY WRITE 123 01:02:22 0 EOF\\n'
  procns['read_bounded']=read
  if scenario in ['permission','fd_race','churn','malformed_locks']:
    try: procns['proc_audit'](); raise AssertionError('expected refusal')
    except (PermissionError,FileNotFoundError,procns['Refused']): pass
  else:
    facts=procns['proc_audit']()
    assert facts['proc_audit_complete']
    assert facts['active_docker_cli_count']==int(scenario=='cli')
    assert facts['deleted_lock_owner_count']==int(scenario=='deleted')
    assert facts['deleted_kernel_lock_count']==int(scenario=='deleted')
  results.append('proc_'+scenario)
print(json.dumps({'passed':len(results),'cases':results}))
`;
    const result = spawnSync(python, ["-B", "-"], {
      input: program, encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).passed).toBe(22);
  });
});
