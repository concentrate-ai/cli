"""With no key saved, cn asks for it before showing the home menu."""
import errno
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
with tempfile.TemporaryDirectory(prefix='cn-first-run-') as directory:
    env = {k: v for k, v in os.environ.items() if k != 'CONCENTRATE_API_KEY'}
    env.update({'CN_CONFIG_HOME': directory, 'CN_OFFLINE': '1', 'CN_NO_MOTION': '1',
                'NO_COLOR': '1', 'TERM': 'xterm-256color', 'PATH': directory,
                'HOME': directory})
    child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave,
                             stderr=slave, env=env)
    os.close(slave)
    seen = ''

    def wait_for(text):
        global seen
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
        raise AssertionError('Missing ' + repr(text) + '\n' + seen)

    try:
        wait_for('API key')
        plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', seen)
        assert 'Workspace / Home' not in plain, 'the menu appeared before the key prompt'
        seen = ''
        os.write(master, b'\x1b')  # Esc skips the prompt
        wait_for('Workspace / Home')
        wait_for('no key yet')
        os.write(master, b'q')
        # Keep draining the terminal: the child cannot finish exiting until its
        # last output has been read.
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    break
        assert child.poll() == 0, child.poll()
    finally:
        if child.poll() is None:
            child.kill()
