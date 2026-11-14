"""Offline fresh-install safety checks; never contacts AWS or operator services."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class PrepareTests(unittest.TestCase):
    # @spec OD-SERVER-010
    def test_fresh_credentials_tls_and_refusal_to_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'private'
            command = ['python3', str(Path(__file__).with_name('prepare.py')),
                       '--hostname', 'opendoc.example.test', '--directory', str(target)]
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertEqual(len((target/'secrets/auth-key').read_bytes()), 32)
            credentials = (target/'credentials.txt').read_bytes()
            password = (target/'secrets/owner-password').read_text()
            self.assertNotIn(password, result.stdout+result.stderr)
            config = json.loads((target/'server.json').read_text())
            self.assertNotEqual(config['database']['user'], config['administration']['user'])
            subprocess.run(['openssl', 'verify', '-CAfile', str(target/'tls/ca.crt'),
                            '-verify_hostname', 'postgres', str(target/'tls/postgres.crt')],
                           check=True, capture_output=True)
            again = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertIn('Refusing an existing deployment directory', again.stderr)
            self.assertEqual((target/'credentials.txt').read_bytes(), credentials)
            self.assertNotIn(password, again.stdout+again.stderr)

    # @spec OD-SERVER-010
    def test_invalid_hostname_does_not_create_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'private'
            result = subprocess.run(['python3', str(Path(__file__).with_name('prepare.py')),
                                     '--hostname', 'invalid/hostname', '--directory', str(target)],
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
