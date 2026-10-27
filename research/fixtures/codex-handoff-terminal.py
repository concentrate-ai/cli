import json,os,pty,fcntl,termios,struct,subprocess,sys,select,time
config=json.load(open(sys.argv[1]))
m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',36,120,0,0))
p=subprocess.Popen([config['binary'],*config['args']],cwd=config['cwd'],env=config['env'],stdin=s,stdout=s,stderr=s)
os.close(s);out=b'';deadline=time.monotonic()+35;exit_sent=False;migration=False
try:
 while time.monotonic()<deadline:
  if select.select([m],[],[],0.1)[0]:
   try:
    chunk=os.read(m,65536)
    if not chunk:break
   except OSError:break
   out+=chunk
   if b'\x1b[6n' in chunk:os.write(m,b'\x1b[1;1R')
   if b'\x1b[c' in chunk:os.write(m,b'\x1b[?1;2c')
   if b'Try new model' in out and not migration:
    time.sleep(0.5);os.write(m,b'2');time.sleep(0.25);os.write(m,b'\r');migration=True
   if out.count(b'PROBE_REPLY') >= 2 and not exit_sent:
    time.sleep(0.25);os.write(m,b'/exit');time.sleep(0.25);os.write(m,b'\r');exit_sent=True
  if p.poll() is not None:break
 if p.poll() is None:p.kill()
 p.wait(timeout=5)
 open(config['cwd']+'/tui.log','wb').write(out)
 assert exit_sent, 'TUI did not complete resumed request; see '+config['cwd']+'/tui.log'
 assert p.returncode==0, 'TUI exited '+str(p.returncode)
 print('Interactive CLI resumed and exited successfully')
finally:
 if p.poll() is None:p.kill();p.wait()
 os.close(m)
