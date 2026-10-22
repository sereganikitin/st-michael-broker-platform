import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import hashlib
import json

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recover-host-ipv6.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

CONFIG = {'network': {'version': 2, 'ethernets': {
    'eth0': {'dhcp4': True, 'dhcp6': False, 'accept-ra': False,
             'match': {'macaddress': '00:00:00:00:00:01'},
             'dhcp4-overrides': {'use-dns': False},
             'addresses': ['192.0.2.3/24'],
             'routes': [{'to': '0.0.0.0/0', 'via': '192.0.2.1'}],
             'nameservers': {'addresses': ['192.0.2.1']}, 'link-local': []},
    'eth1': {'dhcp4': False, 'addresses': ['192.0.2.2/24']},
}}}

class RecoveryTests(unittest.TestCase):
    def test_enables_only_ipv6_and_preserves_other_configuration(self):
        original = copy.deepcopy(CONFIG)
        overlay, expected = recovery.desired_overlay(CONFIG)
        self.assertEqual(CONFIG, original)
        self.assertEqual(expected['network']['ethernets']['eth1'], original['network']['ethernets']['eth1'])
        before = original['network']['ethernets']['eth0']
        after = expected['network']['ethernets']['eth0']
        for key in before:
            if key not in ['addresses', 'routes', 'link-local']:
                self.assertEqual(before[key], after[key])
        self.assertEqual(after['link-local'], ['ipv6'])
        self.assertEqual(after['addresses'][:-1], before['addresses'])
        self.assertEqual(after['addresses'][-1], recovery.ASSIGNED_ADDRESS)
        self.assertEqual(after['routes'][:-1], before['routes'])
        self.assertEqual(after['routes'][-1]['via'], recovery.HISTORICAL_GATEWAY)
        self.assertEqual(after['routes'][-1]['to'], '::/0')
        self.assertEqual(set(overlay['network']['ethernets']), {'eth0'})

    def test_does_not_add_link_local_override_when_default_is_already_ipv6(self):
        config = copy.deepcopy(CONFIG)
        del config['network']['ethernets']['eth0']['link-local']
        overlay, _ = recovery.desired_overlay(config)
        self.assertNotIn('link-local', overlay['network']['ethernets']['eth0'])

    def test_refuses_unexpected_network_backend_or_state(self):
        for change in [{'renderer': 'NetworkManager'}, {'dhcp4': False}, {'dhcp6': True}, {'accept-ra': True},
                       {'addresses': [recovery.ASSIGNED_ADDRESS]}, {'routes': [{'to': '::/0', 'via': 'fe80::1'}]}]:
            config = copy.deepcopy(CONFIG)
            config['network']['ethernets']['eth0'].update(change)
            with self.assertRaises(RuntimeError):
                recovery.desired_overlay(config)

    def test_rollback_removes_only_our_unchanged_overlay_and_reloads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backups = root / 'backups'
            directory = backups / ('a' * 40)
            directory.mkdir(parents=True)
            overlay = root / 'overlay.yaml'
            payload = b'our overlay'
            overlay.write_bytes(payload)
            (directory / 'state.json').write_text(json.dumps({'overlaySha256': hashlib.sha256(payload).hexdigest()}))
            with patch.object(recovery, 'BACKUP_ROOT', backups), patch.object(recovery, 'OVERLAY', overlay), patch.object(recovery, 'run') as run:
                recovery.rollback(directory)
                self.assertFalse(overlay.exists())
                self.assertEqual([c.args for c in run.call_args_list], [('netplan', 'generate'), ('networkctl', 'reload'), ('networkctl', 'reconfigure', 'eth0')])

    def test_rollback_refuses_changed_overlay(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backups = root / 'backups'
            directory = backups / ('a' * 40)
            directory.mkdir(parents=True)
            overlay = root / 'overlay.yaml'
            overlay.write_bytes(b'somebody else changed this')
            (directory / 'state.json').write_text(json.dumps({'overlaySha256': hashlib.sha256(b'ours').hexdigest()}))
            with patch.object(recovery, 'BACKUP_ROOT', backups), patch.object(recovery, 'OVERLAY', overlay), patch.object(recovery, 'run') as run:
                with self.assertRaises(RuntimeError):
                    recovery.rollback(directory)
                self.assertTrue(overlay.exists())
                run.assert_not_called()

    def test_committed_recovery_is_not_rolled_back_by_a_late_timer(self):
        with tempfile.TemporaryDirectory() as temp:
            backups = Path(temp)
            directory = backups / ('a' * 40)
            directory.mkdir()
            (directory / 'committed').write_text('verified')
            with patch.object(recovery, 'BACKUP_ROOT', backups), patch.object(recovery, 'run') as run:
                recovery.rollback(directory)
                run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
