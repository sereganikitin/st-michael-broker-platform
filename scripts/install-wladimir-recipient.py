"""Exact approved recipient, same-image replacement, private rollback snapshots.

2026-10-22: fourth technical-alert recipient @wladimirvarrior (owner request),
quiet hours 19:00-10:00 MSK. Same procedure as install-vish-recipient.py; the
existing additional recipient and its 22:00-09:00 policy are preserved.

No CRM calls, DB mutation, build, migration, queue deletion or second poller.
Executed only by the pinned production workflow while it owns the deploy lock.
"""
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request

LIVE = '50c88ff5cef87894394c2d563904e2befafd781a'
ROOT = Path('/var/lib/stmichael/telegram-quiet')
ENV_KEYS = {'OPS_ALERT_CHAT_IDS', 'OPS_SUPPORT_ADMIN_IDS', 'TELEGRAM_NEWS_MODERATOR_CHAT_IDS'}
USERNAME = 'wladimirvarrior'
EXISTING_RECIPIENTS = 3
DEFAULT_SCHEDULE = {'start': '22:00', 'end': '09:00', 'timeZone': 'Europe/Moscow'}
TARGET_SCHEDULE = {'start': '19:00', 'end': '10:00', 'timeZone': 'Europe/Moscow'}
PHASE = 'preflight'

def require(value):
    if not value:
        raise RuntimeError('recipient_install_refused')

def command(*args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    require(result.returncode == 0)
    return result.stdout

class Engine(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(90)
        self.sock.connect('/var/run/docker.sock')

def docker(method, endpoint, body=None):
    conn = Engine('localhost', timeout=90)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        conn.request(method, '/v1.41' + endpoint, payload, {'Content-Type': 'application/json'})
        response = conn.getresponse()
        raw = response.read()
        require(200 <= response.status < 300)
        return json.loads(raw) if raw else None
    finally:
        conn.close()

def inspect(name):
    return docker('GET', '/containers/' + name + '/json')

def environment(container):
    result = {}
    for item in container['Config']['Env']:
        key, value = item.split('=', 1)
        require(key not in result)
        result[key] = value
    return result

def private_write(path, data):
    require(not path.exists() and not path.is_symlink())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def env_replacement(raw, changes):
    require(set(changes) == ENV_KEYS)
    for value in changes.values():
        require(re.fullmatch(r'-?\d+(,-?\d+)*', value))
    lines = raw.decode().splitlines(keepends=True)
    kept = []
    seen = set()
    for line in lines:
        key = line.split('=', 1)[0]
        if key in ENV_KEYS:
            require(key not in seen)
            seen.add(key)
            continue
        # Refuse an ambiguous spelling, rather than sourcing the environment.
        require(not re.match(r'\s*(export\s+)?(?:' + '|'.join(ENV_KEYS) + r')\s*=', line))
        kept.append(line)
    return (''.join(kept).rstrip('\n') + '\n' + ''.join(k + "='" + changes[k] + "'\n" for k in sorted(changes))).encode()

def api_payload(old, changes):
    result = copy.deepcopy(old['Config'])
    old_env = environment(old)
    require(old_env.get('GIT_SHA') == LIVE)
    require(set(changes) == ENV_KEYS)
    old_env.update(changes)
    result['Env'] = [k + '=' + v for k, v in old_env.items()]
    result['Image'] = old['Image']
    # Never run the image's migration entrypoint during a configuration change.
    result['Entrypoint'] = ['node', 'apps/api/dist/main.js']
    result['Cmd'] = []
    result['HostConfig'] = copy.deepcopy(old['HostConfig'])
    networks = old['NetworkSettings']['Networks']
    require(len(networks) == 1)
    endpoints = {}
    for name, endpoint in networks.items():
        require(endpoint['IPAddress'] and not endpoint.get('GlobalIPv6Address'))
        aliases = [a for a in endpoint.get('Aliases', []) if a not in (old['Id'], old['Id'][:12])]
        endpoints[name] = {'IPAMConfig': {'IPv4Address': endpoint['IPAddress']}, 'Aliases': aliases}
    result['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    return result

def replace_container(old, payload, backup_name):
    name = old['Name'].lstrip('/')
    docker('POST', '/containers/' + old['Id'] + '/stop?t=30')
    require(not inspect(old['Id'])['State']['Running'])
    for network in old['NetworkSettings']['Networks']:
        docker('POST', '/networks/' + network + '/disconnect', {'Container': old['Id'], 'Force': False})
    docker('POST', '/containers/' + old['Id'] + '/rename?name=' + backup_name)
    new = docker('POST', '/containers/create?name=' + name, payload)
    docker('POST', '/containers/' + new['Id'] + '/start')
    return new['Id']

def restore_container(old, backup_name):
    name = old['Name'].lstrip('/')
    try:
        present = inspect(name)
    except RuntimeError:
        present = None
    if present and present['Id'] != old['Id']:
        docker('DELETE', '/containers/' + present['Id'] + '?force=true&v=false')
    current = inspect(old['Id'])
    if current['Name'].lstrip('/') != name:
        docker('POST', '/containers/' + old['Id'] + '/rename?name=' + name)
    for network, endpoint in old['NetworkSettings']['Networks'].items():
        if network not in inspect(old['Id'])['NetworkSettings']['Networks']:
            docker('POST', '/networks/' + network + '/connect', {'Container': old['Id'], 'EndpointConfig': {
                'IPAMConfig': {'IPv4Address': endpoint['IPAddress']}, 'Aliases': endpoint.get('Aliases', [])}})
    if not inspect(old['Id'])['State']['Running']:
        docker('POST', '/containers/' + old['Id'] + '/start')

def schedule_of(entry):
    return {key: entry[key] for key in ('start', 'end', 'timeZone')}

def extended_policy(policy, plan):
    """Append the target; the primary and every existing additional policy stay byte-equal."""
    require(set(policy) == {'token', 'policy', 'additionalPolicies'})
    require(schedule_of(policy['policy']) == DEFAULT_SCHEDULE)
    existing = policy['additionalPolicies']
    require(isinstance(existing, list) and len(existing) == EXISTING_RECIPIENTS - 2)
    known = [policy['policy']['chatId']] + [entry['chatId'] for entry in existing]
    require(all(entry['botId'] == plan['botId'] for entry in existing))
    require(all(chat_id in plan['oldRecipients'] for chat_id in known))
    require(plan['target'] not in known)
    result = copy.deepcopy(policy)
    result['additionalPolicies'] = copy.deepcopy(existing) + [{'botId': plan['botId'], 'chatId': plan['target'], **TARGET_SCHEDULE}]
    return result

def wait_health(url, predicate):
    for _ in range(30):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if predicate(json.load(response)):
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError('recipient_health_refused')

def main(stage, source, public_key):
    global PHASE
    require(re.fullmatch('[a-f0-9]{40}', source))
    require(stage.is_dir() and stage.resolve() == stage)
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.resolve() == ROOT)
    public_path=stage/'recipient-public.pem'
    private_write(public_path,public_key)
    command('openssl','pkey','-pubin','-in',str(public_path),'-pubcheck','-noout')
    api = inspect('st-michael-api')
    quiet = inspect('st-michael-telegram-quiet')
    protected = {name: inspect(name)['Id'] for name in ('st-michael-redis','st-michael-postgres','st-michael-web','st-michael-nginx','st-michael-tg-relay')}
    require(api['State']['Running'] and quiet['State']['Running'])
    require(environment(api).get('GIT_SHA') == LIVE)
    require(api['HostConfig'].get('Privileged') is False)
    require(api['Config']['WorkingDir'] == '/app')
    require(quiet['HostConfig']['NetworkMode'] == 'host')
    require(quiet['Config']['Cmd'] == ['node','/quiet/telegram-quiet-gateway.js'])
    env_path = Path.cwd() / '.env'
    require(env_path.is_file() and not env_path.is_symlink())
    old_env = env_path.read_bytes()
    policy_path = ROOT / 'policy/policy.json'
    require(policy_path.is_file() and not policy_path.is_symlink())
    old_policy = policy_path.read_bytes()
    policy = json.loads(old_policy)
    plan = json.loads(command('docker','exec','-i','-w','/app','-e','PREPARE_WLADIMIR_RECIPIENT=1','st-michael-api','node',data=(stage/'scripts/prepare-wladimir-recipient.cjs').read_bytes()))
    PHASE = 'identity_verified'
    require(hashlib.sha256(policy['token'].encode()).hexdigest() == plan['tokenHash'])
    require(policy['policy']['botId'] == plan['botId'])
    require(plan['target'] not in plan['oldRecipients'] and len(plan['oldRecipients']) == EXISTING_RECIPIENTS)
    target_policy = extended_policy(policy, plan)
    changes = plan['changes']
    target_env = env_replacement(old_env, changes)
    payload = api_payload(api, changes)
    stamp = 'wladimir-' + source
    release = ROOT / 'releases' / stamp
    require(not release.exists())
    release.mkdir(mode=0o700)
    (release/'ops').mkdir(mode=0o700)
    for filename in ('telegram-quiet-hours.js','telegram-quiet-gateway.js'):
        private_write(release/'ops'/filename,(stage/'ops'/filename).read_bytes())
    private_write(release/'previous-policy.json',old_policy)
    private_write(release/'previous.env',old_env)
    private_write(release/'previous-api.json',json.dumps(api).encode())
    private_write(release/'previous-gateway.json',json.dumps(quiet).encode())
    private_write(release/'policy.json',json.dumps(target_policy).encode())
    private_write(release/'target.env',target_env)
    gateway_payload = copy.deepcopy(quiet['Config'])
    gateway_payload['Image'] = quiet['Image']
    gateway_payload['Labels']['st-michael.source-sha'] = source
    gateway_payload['HostConfig'] = copy.deepcopy(quiet['HostConfig'])
    mounts = gateway_payload['HostConfig'].get('Mounts',[])
    require(len(mounts)==3 and not gateway_payload['HostConfig'].get('Binds'))
    require({m['Target'] for m in mounts} == {'/quiet','/policy','/data'})
    for mount in mounts:
        require(mount['Type'] == 'bind')
        if mount['Target']=='/quiet':
            require(mount['ReadOnly'])
            mount['Source']=str(release/'ops')
        elif mount['Target']=='/policy':
            require(mount['ReadOnly'] and mount['Source']==str(ROOT/'policy'))
        else:
            require(not mount.get('ReadOnly') and mount['Source']==str(ROOT/'data'))
    require(inspect('st-michael-api')['Id']==api['Id'])
    changed_quiet = False
    changed_api = False
    committed = False
    try:
        PHASE = 'gateway_replace'
        # The old listener is stopped before changing policy or starting its replacement.
        docker('POST','/containers/'+quiet['Id']+'/stop?t=30')
        require(not inspect(quiet['Id'])['State']['Running'])
        changed_quiet = True
        os.replace(release/'policy.json',policy_path)
        docker('POST','/containers/'+quiet['Id']+'/rename?name='+stamp+'-gateway')
        new_quiet=docker('POST','/containers/create?name=st-michael-telegram-quiet',gateway_payload)
        docker('POST','/containers/'+new_quiet['Id']+'/start')
        expected_quiet=[schedule_of(entry) for entry in target_policy['additionalPolicies']]
        wait_health('http://172.18.0.1:18082/healthz',lambda p:p.get('ok') and p.get('additionalQuietHours')==expected_quiet)
        PHASE = 'api_replace'
        changed_api = True
        replace_container(api,payload,stamp+'-api')
        wait_health('http://127.0.0.1:4000/api/health/ready',lambda p:p.get('status')=='ok')
        PHASE = 'api_verify'
        new_api=inspect('st-michael-api')
        require(new_api['Image']==api['Image'])
        expected_env=environment(api);expected_env.update(changes)
        require(environment(new_api)==expected_env)
        require(new_api['HostConfig']==api['HostConfig'])
        require(new_api['Mounts']==api['Mounts'])
        require(all(inspect(name)['Id']==value for name,value in protected.items()))
        wait_health('https://broker.stmichael.ru/api/health',lambda p:p.get('deployedSha')==LIVE)
        require(env_path.read_bytes()==old_env)
        os.replace(release/'target.env',env_path)
        committed = True
        PHASE = 'committed'
    finally:
        if not committed:
            if changed_api:
                restore_container(api,stamp+'-api')
            if changed_quiet:
                restore = release/'restore-policy.json'
                private_write(restore,old_policy)
                os.replace(restore,policy_path)
                restore_container(quiet,stamp+'-gateway')
    # Encrypt only the recipient setting for synchronization into GitHub Secrets.
    # No token, SSH key, database URL or raw contact leaves the host.
    sealed=command('openssl','pkeyutl','-encrypt','-pubin','-inkey',str(public_path),'-pkeyopt','rsa_padding_mode:oaep','-pkeyopt','rsa_oaep_md:sha256',data=json.dumps({'OPS_ALERT_CHAT_IDS':changes['OPS_ALERT_CHAT_IDS']}).encode())
    import base64
    test_state='UNKNOWN'
    try:
        # Exactly one confirmation, through the actual quiet-hours gateway.
        # An ambiguous response is never retried or rolled back into another POST.
        verification=r'''
const fs=require('node:fs'),crypto=require('node:crypto');
const config=JSON.parse(fs.readFileSync('/policy/policy.json','utf8')),target=config.additionalPolicies[config.additionalPolicies.length-1];
if(target.start!=='19:00'||target.end!=='10:00')throw Error('target');
const source=process.argv[1],deliveryId='wladimir-confirmation-'+source;
const body=JSON.stringify({chat_id:target.chatId,text:'Технические уведомления подключены. Тихое время: с 19:00 до 10:00 по Москве. Ночные сообщения будут отправляться после 10:00.'});
(async()=>{
const r=await fetch('http://172.18.0.1:18082/private/bot'+config.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json','x-st-michael-delivery-id':deliveryId},body,signal:AbortSignal.timeout(15000)});
const p=await r.json();let state='UNKNOWN';
if(r.status===200&&p.ok===true&&Number.isSafeInteger(p.result?.message_id)&&String(p.result?.chat?.id)===target.chatId)state='SENT';
else if(r.status===202&&p.queued===true){
 const id=crypto.createHash('sha256').update(deliveryId+':sendMessage:').update(body).digest('hex');
 const dir=crypto.createHash('sha256').update(target.botId+':'+target.chatId).digest('hex');
 const name=crypto.createHash('sha256').update(id).digest('hex')+'.json';
 const entry=JSON.parse(fs.readFileSync('/data/outbox/recipients/'+dir+'/'+name,'utf8'));if(entry.state==='PENDING')state='PENDING';
}
console.log(JSON.stringify({state}));
})().catch(()=>console.log('{"state":"UNKNOWN"}'));
'''
        verification_result=json.loads(command('docker','exec','st-michael-telegram-quiet','node','-e',verification,source))
        if verification_result.get('state') in ('SENT','PENDING'):
            test_state=verification_result['state']
    except Exception:
        pass
    report={'ok':True,'configured':True,'targetUsername':USERNAME,'recipientCount':EXISTING_RECIPIENTS+1,'existingRecipientsPreserved':True,
        'adminRightsUnchanged':True,'moderatorsUnchanged':True,'sameApplicationImage':True,'applicationSha':LIVE,'infrastructurePreserved':True,'databaseWrites':False,'crmWrites':False,
        'quietHours':TARGET_SCHEDULE,'testMessageState':test_state,'testDeliveryConfirmed':test_state=='SENT','sealedRecipients':base64.b64encode(sealed).decode()}
    private_write(release/'installed-report.json',json.dumps(report).encode())
    print('TECHNICAL_RECIPIENT_RESULT='+json.dumps(report))

if __name__=='__main__':
    try:
        import base64
        main(Path(sys.argv[1]).resolve(),sys.argv[2],base64.b64decode(sys.argv[3],validate=True))
    except Exception:
        print('TECHNICAL_RECIPIENT_RESULT='+json.dumps({'ok':False,'error':'INSTALL_REFUSED','phase':PHASE}))
        sys.exit(1)
