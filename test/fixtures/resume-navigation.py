"""The cross-provider session picker exits cleanly without launching an agent."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

for key, code in ((b'\x1b', 0), (b'\x03', 130)):
    with tempfile.TemporaryDirectory(prefix='cn-resume-navigation-') as root:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
        store = os.path.join(root, 'codex', 'sessions', '2026', '10', '27')
        os.makedirs(store)
        with open(os.path.join(store, 'saved.jsonl'), 'w') as file:
            file.write(json.dumps({'type': 'session_meta', 'payload': {'id': 'subscription-session', 'cwd': root, 'model_provider': 'openai'}}) + '\n')
            file.write('PRIVATE_HISTORY_NOT_FOR_THE_PICKER\n')
        binary = os.path.join(root, 'tool-bin')
        os.makedirs(binary)
        with open(os.path.join(binary, 'codex'), 'w') as file:
            file.write('#!/bin/sh\necho AGENT_WAS_LAUNCHED\n')
        os.chmod(os.path.join(binary, 'codex'), 0o755)
        env = {**os.environ, 'HOME': root, 'CODEX_HOME': os.path.join(root, 'codex'), 'CN_CONFIG_HOME': os.path.join(root, 'cn'), 'CONCENTRATE_API_KEY': 'sk-test', 'PATH': binary, 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'CN_OFFLINE': '1'}
        child = subprocess.Popen([sys.argv[1], sys.argv[2], 'codex', 'resume'], stdin=slave, stdout=slave, stderr=slave, cwd=root, env=env)
        os.close(slave)
        output = b''
        try:
            deadline = time.monotonic() + 8
            while b'subscription-session' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            assert b'subscription-session' in output, 'Subscription conversation was hidden'
            assert b'\x1b[?1049h' in output, 'Picker was not fullscreen'
            os.write(master, key)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if not select.select([master], [], [], 0.1)[0]:
                    if child.poll() is not None:
                        break
                    continue
                try:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    output += chunk
                except OSError:
                    break
            assert child.wait(timeout=5) == code
            assert b'\x1b[?1049l' in output, 'Picker did not restore shell'
            assert b'Cancelled' not in output, 'Cancellation leaked into shell'
            assert b'AGENT_WAS_LAUNCHED' not in output, 'Cancel launched the agent'
            assert b'PRIVATE_HISTORY' not in output, 'Picker exposed conversation body'
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
print('Cross-provider picker, Escape, Ctrl+C, shell restoration and history privacy passed')
