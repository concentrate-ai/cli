"""Choose an OpenCode session from its session list in cn's menu."""
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

with tempfile.TemporaryDirectory(prefix='cn-opencode-menu-') as root:
    binary = os.path.join(root, 'bin')
    os.makedirs(binary)
    tool = os.path.join(binary, 'opencode')
    with open(tool, 'w') as f:
        f.write('''#!/bin/sh
case "$1" in
  --help) echo --standalone; exit 0 ;;
  --version) echo 'opencode v2.0.20'; exit 0 ;;
  session) printf '[{"id":"ses_latest","title":"Latest session","directory":"%s","updated":2},{"id":"ses_existing","title":"Older session","directory":"%s","updated":1}]\\n' "$PWD" "$PWD"; exit 0 ;;
  api) exit 0 ;;
esac
printf '%s\\n' "$@" > "$CN_TEST_RECORD"
echo OPENCODE_NATIVE_STARTED
''')
    os.chmod(tool, 0o755)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    env = {**os.environ, 'HOME': root, 'CN_CONFIG_HOME': os.path.join(root, 'cn'),
           'CN_OFFLINE': '1', 'CN_NO_MOTION': '1', 'CONCENTRATE_API_KEY': 'sk-test',
           'PATH': binary + ':' + os.path.dirname(sys.argv[1]), 'TERM': 'xterm-256color',
           'NO_COLOR': '1', 'CN_TEST_RECORD': os.path.join(root, 'args')}
    child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave,
                             stderr=slave, cwd=root, env=env)
    os.close(slave)
    output = b''
    def expect(text):
        global output
        deadline = time.monotonic() + 12
        while text not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                output += os.read(master, 65536)
        assert text in output, 'Missing ' + repr(text) + ': ' + repr(output[-3000:])
    try:
        expect(b'quit')
        os.write(master, b'\x1b[H' + b'\x1b[B' * 4 + b'\r')
        expect(b'Resume a session')
        assert b'opencode' in output, 'OpenCode missing from tool selector'
        os.write(master, b'\x1b[H' + b'\x1b[B' * 2 + b'\r')
        expect(b'Older session')
        assert b'Latest session' in output
        os.write(master, b'\x1b[B\r')
        expect(b'OPENCODE_NATIVE_STARTED')
        with open(env['CN_TEST_RECORD']) as f:
            assert f.read().splitlines() == ['--standalone', '--session', 'ses_existing']
        output = b''
        expect(b'quit')
        os.write(master, b'q')
        child.wait(timeout=5)
        assert child.returncode == 0
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
print('OpenCode tool selection opens the selected session')
