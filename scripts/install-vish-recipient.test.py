import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-vish-recipient.py'))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Contract(unittest.TestCase):
    def test_environment_preserves_unrelated_bytes(self):
        raw=b"# preserved\nPASSWORD='a $ b'\nOPS_ALERT_CHAT_IDS='1,2'\nOTHER=x\n"
        changes={'OPS_ALERT_CHAT_IDS':'1,2,3','OPS_SUPPORT_ADMIN_IDS':'1,2','TELEGRAM_NEWS_MODERATOR_CHAT_IDS':'1,2'}
        result=m.env_replacement(raw,changes)
        self.assertIn(b"PASSWORD='a $ b'\n",result)
        self.assertEqual(result.count(b'OPS_ALERT_CHAT_IDS='),1)
        self.assertIn(b'OTHER=x\n',result)
        with self.assertRaises(RuntimeError):m.env_replacement(b' export OPS_ALERT_CHAT_IDS=x\n',changes)
        with self.assertRaises(RuntimeError):m.env_replacement(raw,{**changes,'OTHER':'bad'})

    def test_same_image_config_and_network_preservation(self):
        old={'Id':'a'*64,'Image':'sha256:'+'b'*64,'Config':{'Env':['GIT_SHA='+m.LIVE,'SECRET=private'], 'Cmd':['old'],'Entrypoint':['/entrypoint.sh'],'WorkingDir':'/app'},
             'HostConfig':{'Binds':['volume:/app/uploads'],'PortBindings':{'4000/tcp':[{'HostIp':'127.0.0.1','HostPort':'4000'}]}},
             'NetworkSettings':{'Networks':{'prod':{'IPAddress':'172.18.0.4','Aliases':['api','a'*12]}}}}
        changes={'OPS_ALERT_CHAT_IDS':'1,2,3','OPS_SUPPORT_ADMIN_IDS':'1,2','TELEGRAM_NEWS_MODERATOR_CHAT_IDS':'1,2'}
        target=m.api_payload(old,changes)
        self.assertEqual(target['Image'],old['Image'])
        self.assertEqual(target['HostConfig'],old['HostConfig'])
        self.assertIn('SECRET=private',target['Env'])
        self.assertEqual(target['Entrypoint'],['node','apps/api/dist/main.js'])
        self.assertEqual(target['NetworkingConfig']['EndpointsConfig']['prod'],{'IPAMConfig':{'IPv4Address':'172.18.0.4'},'Aliases':['api']})
        self.assertEqual(old['Config']['Entrypoint'],['/entrypoint.sh'])
        old['Config']['Env']=['GIT_SHA=wrong']
        with self.assertRaises(RuntimeError):m.api_payload(old,changes)

    def test_no_business_writes_or_rebuild(self):
        source=Path(__file__).with_name('install-vish-recipient.py').read_text()
        for forbidden in ['redis-cli','FLUSHALL','prisma migrate','docker compose up','git reset','/leads','/contacts']:
            self.assertNotIn(forbidden,source)
        source=Path(__file__).with_name('prepare-vish-recipient.cjs').read_text()
        self.assertIn('default_transaction_read_only=on',source)
        for forbidden in ["'getUpdates'","method:'POST'",'.upsert(','db.update(']:self.assertNotIn(forbidden,source)

if __name__=='__main__':unittest.main()
