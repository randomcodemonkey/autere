#!/usr/bin/env python3
"""
TUI smoke test driver — runs the TUI in a pty, logs in, exercises the core
loop (sessions pane, chat render, send), and captures raw terminal output
for the ANSI→PNG renderer (render.mjs).

Usage: python3 smoke/driver.py [backend-url] [user] [password]
Outputs: smoke/out/*.raw (also prints PASS/FAIL per assertion).
"""
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3947'
USER = sys.argv[2] if len(sys.argv) > 2 else 'admin'
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else 'testpw'
W, H = 120, 36
OUT = os.path.join(os.path.dirname(__file__), 'out')
os.makedirs(OUT, exist_ok=True)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))

proc = subprocess.Popen(
    ['npx', 'tsx', 'index.tsx', URL],
    cwd=os.path.join(os.path.dirname(__file__), '..'),
    stdin=slave, stdout=slave, stderr=slave,
    env={**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'},
    preexec_fn=os.setsid,
)
os.close(slave)

buf = bytearray()

def read_for(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                buf.extend(os.read(master, 65536))
            except OSError:
                break

def drain(idle_rounds=2, max_wait=20):
    """Wait until output goes idle."""
    start, last, stable = time.time(), -1, 0
    while time.time() - start < max_wait:
        read_for(0.3)
        if len(buf) == last:
            stable += 1
            if stable >= idle_rounds:
                return
        else:
            stable, last = 0, len(buf)

def save(name, start=0):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(bytes(buf[start:]))

failures = []
def check(needle, what, blob):
    if needle in blob:
        print(f'PASS: {what}')
    else:
        print(f'FAIL: {what}')
        failures.append(what)

# ── Login screen (tsx cold start can take a few seconds) ──
start = time.time()
while time.time() - start < 25 and b'autere TUI' not in bytes(buf):
    read_for(0.5)
save('tui-login.raw')
check('autere TUI'.encode(), 'login screen rendered', bytes(buf))

# ── Login: URL prefilled → Enter → user → Enter → password → Enter ──
os.write(master, b'\r'); time.sleep(0.3)
os.write(master, USER.encode()); time.sleep(0.2)
os.write(master, b'\r'); time.sleep(0.3)
os.write(master, PASSWORD.encode()); time.sleep(0.2)
login_start = len(buf)
os.write(master, b'\r')
drain()
save('tui-dashboard.raw', login_start)
dash = bytes(buf[login_start:])

# ── Switch to the seeded session (arrow down selects it, Enter loads it) ──
os.write(master, b'\x1b[B'); time.sleep(0.3)
switch_start = len(buf)
os.write(master, b'\r')
drain()
after_switch = bytes(buf[switch_start:])
save('tui-dashboard.raw', login_start)
check(b'seeded', 'seeded session listed + switched', after_switch)
check(b'Hello from the seeded session', 'user message rendered', after_switch)
check(b'\x1b[38;2;0;255;0m', 'color override from tui-colors.json applied', after_switch)
check(b'TUI smoke test reply', 'assistant reply rendered', after_switch)
check(b'idle', 'session state in status bar', after_switch)

# ── Help overlay (h opens, any key closes) ──
help_start = len(buf)
os.write(master, b'h'); time.sleep(0.3)
drain(idle_rounds=1)
help_buf = bytes(buf[help_start:])
save('tui-help.raw', help_start)
check(b'Keyboard navigation', 'help overlay opens on h', help_buf)
os.write(master, b'\x1b'); time.sleep(0.4)
drain(idle_rounds=1)
check(b'Type a message', 'help overlay closes (chat visible again)', bytes(buf[help_start:]))

# ── Send a message (Tab to input, type, Enter) ──
send_start = len(buf)
os.write(master, b'\t'); time.sleep(0.3)
os.write(master, b'ping from tui'); time.sleep(0.3)
os.write(master, b'\r')
drain()
save('tui-after-send.raw', send_start)
check(b'ping from tui', 'message typed + sent (optimistic entry visible)', bytes(buf[send_start:]))

print('SMOKE ' + ('PASS' if not failures else f'FAIL ({len(failures)} failures)'))
os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
sys.exit(1 if failures else 0)
