"""Exercise real raw-mode input without touching the user's configuration."""
import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
with tempfile.TemporaryDirectory(prefix='cn-navigation-') as directory:
    env = {**os.environ, 'CN_CONFIG_HOME': directory, 'CN_OFFLINE': '1',
           'CN_NO_MOTION': '1', 'NO_COLOR': '1', 'TERM': 'xterm-256color',
           'CONCENTRATE_API_KEY': 'sk-navigation-test', 'PATH': directory}
    child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave,
                             stderr=slave, env=env)
    os.close(slave)
    pending = ''
    transcript = ''

    def expect(text):
        global pending, transcript
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', pending)
            if text in plain:
                pending = ''
                return
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536).decode('utf-8', errors='replace')
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                pending += chunk
                transcript += chunk
        raise AssertionError('Missing ' + repr(text) + '\n' + transcript)

    def press(keys):
        os.write(master, keys.encode())

    try:
        expect('quit')
        assert '\x1b[?1049h' in transcript, 'cn did not enter the alternate screen'
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 70, 0, 0))
        child.send_signal(signal.SIGWINCH)
        expect('quit')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
        child.send_signal(signal.SIGWINCH)
        expect('quit')
        press('\x1b[H' + '\x1b[B' * 5 + '\r')  # Home Cursor desktop
        expect('Cursor desktop settings')
        assert 'Default model' not in pending, 'Cursor must choose models in the editor'
        press('\x1b')
        expect('quit')
        press('\x1b[F\r')  # Doctor
        expect('LIVE ROUTE CHECKS')
        assert child.poll() is None, 'Doctor closed cn'
        press('\x1b[B\r')  # Recheck installs
        expect('Return to the previous menu')
        press('\r')
        expect('LIVE ROUTE CHECKS')
        press('\x1b')
        expect('quit')
        press('\x1b[F\x1b[A\x1b[A\r')  # Settings
        expect('TOOLS')
        press('\r')
        expect('Configure permanently')
        press('\x1b')
        expect('TOOLS')
        press('\x1b[F\x1b[A\r')  # Configuration
        expect('Return to the previous menu')
        assert 'sk-navigation-test' not in transcript, 'Key leaked'
        press('\r')
        expect('TOOLS')
        press('\x1b[F\x1b[A\x1b[A\r')  # API key prompt
        expect('Enter saves CONCENTRATE_API_KEY')
        press('\x1b')  # Esc backs out to Settings instead of ignoring it or quitting cn
        expect('TOOLS')
        assert child.poll() is None, 'Cancelling the key prompt closed cn'
        press('\x1b')
        expect('quit')
        press('\x1b[H' + '\x1b[B' * 6 + '\r')  # Home Configure
        expect('Configure a tool')
        press('\x1b[F\x1b[A')  # Cursor desktop
        expect("Cursor's servers")
        press('\r')  # Needs a saved key; remain inside cn
        expect('Return to the previous menu')
        press('\r')
        expect('Configure a tool')
        press('\x1b[H')
        press('\r')  # Missing tool: show the result, remain inside cn
        expect('Return to the previous menu')
        press('\r')
        expect('Configure a tool')
        press('\x1b')
        expect('quit')
        press('\x1b[H' + '\x1b[B' * 7 + '\r')  # Home Reset
        expect('Reset a tool')
        press('\r')  # No managed integration to reset
        expect('Return to the previous menu')
        press('\r')
        expect('Reset a tool')
        press('\x1b')
        expect('quit')
        press('\x1b[H\r')  # Missing tool, no setup or exit
        expect('Return to the previous menu')
        press('\r')
        expect('quit')
        tool = os.path.join(directory, 'claude')
        with open(tool, 'w') as file:
            file.write('#!/bin/sh\necho HARNESS_STARTED\nexit 7\n')
        os.chmod(tool, 0o755)
        press('\r')
        expect('Return to the previous menu')
        launch_at = transcript.index('HARNESS_STARTED')
        assert transcript.rfind('\x1b[?1049l', 0, launch_at) > transcript.rfind('\x1b[?1049h', 0, launch_at), 'cn kept its screen active during the tool launch'
        press('\r')
        expect('quit')
        assert 'Exit code 7' in transcript, 'Tool exit was not reported'
        press('q')
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
                transcript += chunk.decode('utf-8', errors='replace')
            except OSError:
                break
        assert child.wait(timeout=5) == 0
        assert transcript.rfind('\x1b[?1049l') > transcript.rfind('\x1b[?1049h'), 'Shell screen was not restored: ' + repr(transcript[-500:])
        assert 'Cancelled' not in transcript, 'Quit printed a cancellation message'
        assert '\x1b[?25h' in transcript, 'Cursor was not restored'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
print('Doctor, recheck, Settings, Back, launch error, Quit, and cursor restoration passed')

# Both keyboard interruption and an external termination must restore the shell.
for termination in ('ctrl-c', 'sigterm'):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    with tempfile.TemporaryDirectory(prefix='cn-exit-') as directory:
        env = {**os.environ, 'CN_CONFIG_HOME': directory, 'CN_OFFLINE': '1',
               'CN_NO_MOTION': '1', 'NO_COLOR': '1', 'TERM': 'xterm-256color'}
        child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        try:
            output = ''
            deadline = time.monotonic() + 8
            while 'quit' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536).decode('utf-8', errors='replace')
            assert 'quit' in output, 'No startup frame'
            if termination == 'ctrl-c':
                os.write(master, b'\x03')
            else:
                child.send_signal(signal.SIGTERM)
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
                    output += chunk.decode('utf-8', errors='replace')
                except OSError:
                    break
            child.wait(timeout=5)
            assert '\x1b[?1049l' in output, 'Interrupted cn left its screen behind'
            assert 'Cancelled' not in output, 'Interrupted cn printed Cancelled'
            assert child.returncode == (130 if termination == 'ctrl-c' else -signal.SIGTERM)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
print('Ctrl+C and SIGTERM restore the shell without leftover messages')
