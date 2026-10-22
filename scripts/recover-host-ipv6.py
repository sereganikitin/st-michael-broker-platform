"""Restore provider-managed IPv6 on eth0; preserve IPv4 and application containers."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import yaml

OVERLAY = Path('/etc/netplan/99-stm-restore-ipv6.yaml')
BACKUP_ROOT = Path('/var/backups/stm-ipv6-recovery')
PHASE = 'preflight'

def require(value):
    if not value:
        raise RuntimeError('RECOVERY_REFUSED')

def run(*args, timeout=20):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0)
    return result.stdout

def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)

def desired_overlay(config):
    network = config['network']
    interface = network['ethernets']['eth0']
    require(interface.get('renderer', network.get('renderer', 'networkd')) == 'networkd')
    require(interface.get('dhcp4') is True)
    require(interface.get('dhcp6') is False and interface.get('accept-ra') is False)
    result = {'dhcp6': True, 'accept-ra': True}
    if 'link-local' in interface and 'ipv6' not in interface['link-local']:
        result['link-local'] = list(interface['link-local']) + ['ipv6']
    overrides = interface.get('dhcp4-overrides', {})
    if overrides or interface.get('dhcp6-overrides'):
        result['dhcp6-overrides'] = copy.deepcopy(overrides)
    expected = copy.deepcopy(config)
    expected['network']['ethernets']['eth0'].update(result)
    return {'network': {'version': 2, 'ethernets': {'eth0': result}}}, expected

def ipv4_state():
    addresses = json.loads(run('ip', '-j', '-4', 'address', 'show', 'dev', 'eth0'))
    routes = json.loads(run('ip', '-j', '-4', 'route', 'show', 'default'))
    return {
        'addresses': sorted((a['local'], a['prefixlen']) for link in addresses for a in link.get('addr_info', [])),
        'routes': sorted((r.get('dst'), r.get('gateway'), r.get('dev'), r.get('metric', 0)) for r in routes),
    }

def container_state():
    names = ['api', 'web', 'nginx', 'postgres', 'redis', 'tg-relay', 'telegram-quiet']
    return {name: run('docker', 'inspect', '--format', '{{.Id}} {{.State.Running}}', 'st-michael-' + name).strip() for name in names}

def rollback(directory):
    require(directory.parent == BACKUP_ROOT and re.fullmatch('[a-f0-9]{40}', directory.name))
    require(directory.is_dir() and not directory.is_symlink())
    if (directory / 'committed').exists():
        return
    state = json.loads((directory / 'state.json').read_text())
    if OVERLAY.exists():
        require(not OVERLAY.is_symlink())
        require(hashlib.sha256(OVERLAY.read_bytes()).hexdigest() == state['overlaySha256'])
        OVERLAY.unlink()
        run('netplan', 'generate')
        run('networkctl', 'reload')
        run('networkctl', 'reconfigure', 'eth0')

def bot_identity():
    code = r"""
const base=String(process.env.TELEGRAM_API_BASE||'').replace(/\/+$/,'');
const token=(process.env.OPS_TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_BOT_TOKEN||'').trim();
if(base!=='http://172.18.0.1:8081'||!token)process.exit(1);
(async()=>{try{const r=await fetch(base+'/bot'+token+'/getMe',{redirect:'error',signal:AbortSignal.timeout(10000)});const p=await r.json();console.log(JSON.stringify({ok:r.ok&&p.ok===true&&p.result?.username==='brokerStMichaelbot',status:r.status}));}catch{console.log('{"ok":false}');}})();
"""
    return json.loads(run('docker', 'exec', 'st-michael-api', 'node', '-e', code, timeout=15)).get('ok') is True

def main(mode, source):
    global PHASE
    require(mode in ['inspect', 'apply'] and re.fullmatch('[a-f0-9]{40}', source))
    require(os.geteuid() == 0 and not OVERLAY.exists() and not OVERLAY.is_symlink())
    require(run('systemctl', 'is-active', 'systemd-networkd').strip() == 'active')
    PHASE = 'read_saved_configuration'
    config = yaml.safe_load(run('netplan', 'get'))
    overlay, expected = desired_overlay(config)
    PHASE = 'verify_existing_runtime'
    ipv4 = ipv4_state()
    containers = container_state()
    require(ipv4['addresses'] and ipv4['routes'])
    require(all(value.endswith(' true') for value in containers.values()))
    existing6 = json.loads(run('ip', '-j', '-6', 'address', 'show', 'dev', 'eth0'))
    require(not any(a.get('scope') == 'global' for link in existing6 for a in link.get('addr_info', [])))
    require(not json.loads(run('ip', '-j', '-6', 'route', 'show', 'default')))
    print('IPV6_RECOVERY_PLAN=' + json.dumps({'ok': True, 'mode': mode, 'interface': 'eth0', 'dhcp6': True, 'acceptRA': True, 'ipv4ConfigChanges': False, 'containerRestarts': False, 'automaticRollbackSeconds': 300}), flush=True)
    if mode == 'inspect':
        return
    PHASE = 'prepare_rollback'
    BACKUP_ROOT.mkdir(mode=0o700, exist_ok=True)
    require(not BACKUP_ROOT.is_symlink())
    directory = BACKUP_ROOT / source
    directory.mkdir(mode=0o700)
    payload = yaml.safe_dump(overlay, sort_keys=False).encode()
    private_write(directory / 'original-netplan.yaml', yaml.safe_dump(config).encode())
    private_write(directory / 'state.json', json.dumps({'overlaySha256': hashlib.sha256(payload).hexdigest()}).encode())
    private_write(directory / 'recovery.py', Path(__file__).read_bytes())
    unit = 'stm-ipv6-rollback-' + source[:12]
    run('systemd-run', '--unit=' + unit, '--on-active=300s', '--timer-property=AccuracySec=1s', '/usr/bin/python3', str(directory / 'recovery.py'), 'rollback', str(directory))
    committed = False
    try:
        PHASE = 'generate_ipv6_configuration'
        private_write(OVERLAY, payload)
        require(yaml.safe_load(run('netplan', 'get')) == expected)
        run('netplan', 'generate')
        PHASE = 'reconfigure_eth0'
        run('networkctl', 'reload')
        run('networkctl', 'reconfigure', 'eth0')
        deadline = time.monotonic() + 75
        PHASE = 'wait_for_provider_ipv6'
        connected = False
        while time.monotonic() < deadline:
            result = subprocess.run(['curl', '-6', '--fail', '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '5', '--output', '/dev/null', 'https://api.telegram.org/'], capture_output=True, timeout=7)
            if result.returncode == 0:
                connected = True
                break
            time.sleep(3)
        require(connected)
        PHASE = 'verify_ipv4_containers_and_bot'
        require(ipv4_state() == ipv4)
        require(container_state() == containers)
        require(bot_identity())
        health = json.loads(run('curl', '--fail', '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '10', 'https://broker.stmichael.ru/api/health/ready'))
        require(health.get('status') == 'ok')
        private_write(directory / 'committed', b'IPv6 and bot identity verified; IPv4 and containers preserved.\n')
        committed = True
        run('systemctl', 'stop', unit + '.timer')
        print('IPV6_RECOVERY_RESULT=' + json.dumps({'ok': True, 'telegramIPv6Reachable': True, 'botIdentityConfirmed': True, 'ipv4Preserved': True, 'containerIdsPreserved': True, 'siteReady': True, 'persistentConfig': True, 'messagesSent': 0}))
    finally:
        if not committed:
            rollback(directory)
            run('systemctl', 'stop', unit + '.timer')
            print('IPV6_RECOVERY_RESULT=' + json.dumps({'ok': False, 'rolledBack': True}), flush=True)

if __name__ == '__main__':
    try:
        if sys.argv[1] == 'rollback':
            rollback(Path(sys.argv[2]))
        else:
            main(sys.argv[1], sys.argv[2])
    except Exception:
        print('IPV6_RECOVERY_ERROR=' + PHASE, flush=True)
        sys.exit(1)
