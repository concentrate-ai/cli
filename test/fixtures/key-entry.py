"""A rejected key stays on screen to be fixed; a good key continues; Esc skips."""
import errno
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

harness = sys.argv[1]


def session(steps):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = {**os.environ, 'NO_COLOR': '1', 'CN_NO_MOTION': '1', 'TERM': 'xterm-256color'}
    child = subprocess.Popen([sys.executable.replace('python3', 'node') if False else 'node', harness],
                             stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    seen = ''

    def wait_for(text):
        nonlocal seen
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if text in re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', seen):
                return
            if select.select([master], [], [], 0.1)[0]:
                try:
                    seen += os.read(master, 65536).decode('utf-8', errors='replace')
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
        raise AssertionError('Missing ' + repr(text) + '\n' + seen[-800:])

    try:
        steps(master, wait_for)
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    seen += os.read(master, 65536).decode('utf-8', errors='replace')
                except OSError:
                    break
        assert child.poll() == 0, 'cn exited with %r' % child.poll()
        return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', seen)
    finally:
        if child.poll() is None:
            child.kill()
        os.close(master)


def retry_then_accept(master, wait_for):
    wait_for('Paste your key here')
    os.write(master, b'sk-bad-key\r')
    wait_for('rejected this API key')
    os.write(master, b'\x15')  # Ctrl+U clears the field
    os.write(master, b'sk-good-key\r')
    wait_for('Key verified')


out = session(retry_then_accept)
assert 'RESULT {"key":"sk-good-key"}' in out, out[-400:]
assert 'sk-good-key' not in out.replace('RESULT {"key":"sk-good-key"}', ''), 'the key was echoed'
assert 'sk-bad-key' not in out, 'the key was echoed'


def skip(master, wait_for):
    wait_for('esc')
    os.write(master, b'\x1b')


assert 'RESULT {"skipped":true}' in session(skip)
print('key entry passed')
