#!/usr/bin/env python3
"""Drive the actual workbench PTY using keys; observe only rendered terminal cells.

JSON lines on stdin: {"keys": ["ENTER"], "text": "...", "waitFor": "..."}.
Every command and resulting screen is retained in the optional JSONL trace.
No project, recording, controller state, or model response is read by this driver.
"""
import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import unicodedata

parser = argparse.ArgumentParser()
parser.add_argument('--trace')
parser.add_argument('--check', action='store_true')
parser.add_argument('--width', type=int, default=140)
parser.add_argument('--height', type=int, default=42)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('a child command is required')

keys = {'ENTER': '\r', 'ESC': '\x1b', 'TAB': '\t', 'SHIFT_TAB': '\x1b[Z',
        'UP': '\x1b[A', 'DOWN': '\x1b[B', 'RIGHT': '\x1b[C', 'LEFT': '\x1b[D',
        'HOME': '\x1b[H', 'END': '\x1b[F', 'PAGE_UP': '\x1b[5~', 'PAGE_DOWN': '\x1b[6~',
        'BACKSPACE': '\x7f', 'CTRL_S': '\x13', 'CTRL_C': '\x03', 'CTRL_Z': '\x1a', 'CTRL_Y': '\x19'}
width, height = args.width, args.height
cells = [[' '] * width for _ in range(height)]
styles = [[{} for _ in range(width)] for _ in range(height)]
ink = {}
stable_styles = []
x = y = 0
saved = (0, 0)
pending = ''
synchronized = False
stable_screen = ''
decoder = codecs.getincrementaldecoder('utf-8')('replace')
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLUMNS'], os.environ['LINES'] = str(width), str(height)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
    os.execvp(command[0], command)
trace = open(args.trace, 'a', encoding='utf-8') if args.trace else None
exit_code = None
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

def consume(data):
    global pending, x, y, saved, cells, styles, ink, synchronized, stable_screen, stable_styles
    pending += decoder.decode(data)
    while pending:
        if pending[0] == '\x1b':
            if len(pending) < 2:
                return
            if pending[1] == '[':
                match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', pending)
                if not match:
                    return
                raw, extra, op = match.groups()
                pending = pending[match.end():]
                nums = [int(n) if n else 0 for n in raw.lstrip('?><').split(';')]
                if raw == '?2026' and op in ('h', 'l'):
                    if op == 'h':
                        stable_screen = '\n'.join(''.join(row).rstrip() for row in cells).rstrip()
                        stable_styles = styled_rows()
                    synchronized = op == 'h'
                elif op == 'm':
                    i = 0
                    while i < len(nums):
                        n = nums[i]
                        if n == 0: ink = {}
                        elif n in (1, 3, 4): ink[{1: 'bold', 3: 'italic', 4: 'underline'}[n]] = True
                        elif n in (22, 23, 24): ink.pop({22: 'bold', 23: 'italic', 24: 'underline'}[n], None)
                        elif n in (39, 49): ink.pop('fg' if n == 39 else 'bg', None)
                        elif n in (38, 48) and i + 4 < len(nums) and nums[i + 1] == 2:
                            ink['fg' if n == 38 else 'bg'] = '#%02x%02x%02x' % tuple(nums[i + 2:i + 5])
                            i += 4
                        i += 1
                elif op in ('H', 'f'):
                    y = min(height - 1, max(0, (nums[0] or 1) - 1))
                    x = min(width - 1, max(0, (nums[1] if len(nums) > 1 else 1) - 1))
                elif op == 'J' and nums[0] in (2, 3):
                    cells = [[' '] * width for _ in range(height)]
                    styles = [[dict(ink) for _ in range(width)] for _ in range(height)]
                elif op == 'K':
                    start, end = (0, width) if nums[0] == 2 else (0, x + 1) if nums[0] == 1 else (x, width)
                    cells[y][start:end] = [' '] * (end - start)
                    styles[y][start:end] = [dict(ink) for _ in range(end - start)]
                elif op == 'n' and raw == '6':
                    os.write(fd, f'\x1b[{y + 1};{x + 1}R'.encode())
                elif op == 'c' and not raw.startswith('?'):
                    os.write(fd, b'\x1b[?1;2c')
                elif op in ('A', 'B', 'C', 'D'):
                    n = nums[0] or 1
                    if op == 'A': y = max(0, y - n)
                    if op == 'B': y = min(height - 1, y + n)
                    if op == 'C': x = min(width - 1, x + n)
                    if op == 'D': x = max(0, x - n)
                continue
            if pending[1] == ']':
                match = re.search(r'\x07|\x1b\\', pending)
                if not match:
                    return
                pending = pending[match.end():]
                continue
            if pending[1] == '7': saved = (x, y)
            if pending[1] == '8': x, y = saved
            if pending[1] in '()' and len(pending) < 3:
                return
            pending = pending[3 if pending[1] in '()' else 2:]
            continue
        char, pending = pending[0], pending[1:]
        if char == '\r': x = 0
        elif char == '\n': y = min(height - 1, y + 1)
        elif char == '\b': x = max(0, x - 1)
        elif ord(char) >= 32 and x < width:
            if unicodedata.combining(char):
                if x:
                    previous = x - 1
                    if not cells[y][previous] and previous: previous -= 1
                    cells[y][previous] += char
            else:
                cells[y][x] = char
                styles[y][x] = dict(ink)
                advance = 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
                if advance == 2 and x + 1 < width:
                    cells[y][x + 1] = ''
                    styles[y][x + 1] = dict(ink)
                x += advance

def styled_rows():
    result = []
    for row, colors in zip(cells, styles):
        spans = []
        for text, style in zip(row, colors):
            if spans and spans[-1]['style'] == style: spans[-1]['text'] += text
            else: spans.append({'text': text, 'style': style})
        result.append(spans)
    return result

def screen():
    return stable_screen if synchronized else '\n'.join(''.join(row).rstrip() for row in cells).rstrip()

def drain(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, min(.1, deadline - time.monotonic())))
        if ready:
            try: data = os.read(fd, 65536)
            except OSError: return
            if not data: return
            consume(data)

def report(request, error=None):
    result = {'command': request, 'screen': screen(),
              'width': width, 'height': height, 'styledRows': stable_styles if synchronized else styled_rows(),
              **({'exitCode': exit_code} if exit_code is not None else {}),
              **({'error': error} if error else {})}
    if trace:
        trace.write(json.dumps(result, ensure_ascii=False) + '\n'); trace.flush()
    print(json.dumps(result, ensure_ascii=False), flush=True)

try:
    drain(1)
    report({'start': command})
    for line in sys.stdin:
        request = json.loads(line)
        if 'resize' in request:
            width, height = request['resize']['width'], request['resize']['height']
            cells = [[' '] * width for _ in range(height)]
            styles = [[{} for _ in range(width)] for _ in range(height)]
            stable_styles = []
            stable_screen = ''
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            drain(.2)
        for key in request.get('keys', []):
            value = '\x1b' + key[4:].lower() if key.startswith('ALT_') else keys.get(key, key)
            os.write(fd, value.encode()); drain(.12 if key != 'ESC' else .25)
        for pointer in request.get('mouse', []):
            # SGR mouse input exercises the terminal's real pointer decoder.
            event = pointer.get('event', 'press')
            button = {'press': 0, 'drag': 32, 'move': 35, 'release': 0, 'wheel_up': 64, 'wheel_down': 65}[event]
            suffix = 'm' if event == 'release' else 'M'
            os.write(fd, f'\x1b[<{button};{pointer["x"]};{pointer["y"]}{suffix}'.encode())
            drain(.08)
        if 'text' in request:
            os.write(fd, request['text'].encode()); drain(.2)
        if 'paste' in request:
            os.write(fd, b'\x1b[200~' + request['paste'].encode() + b'\x1b[201~'); drain(.2)
        drain(request.get('wait', .2))
        deadline = time.monotonic() + request.get('timeout', 55)
        alternatives = request.get('waitForAny', [])
        while ((request.get('waitFor') and request['waitFor'] not in screen()) or
               (alternatives and not any(value in screen() for value in alternatives))) and time.monotonic() < deadline:
            drain(.2)
        required = request.get('expect', []) + ([request['waitFor']] if request.get('waitFor') else [])
        missing = [value for value in required if value not in screen()]
        if alternatives and not any(value in screen() for value in alternatives): missing.append('one of ' + repr(alternatives))
        forbidden = [value for value in request.get('reject', []) if value in screen()]
        if request.get('expectExit'):
            deadline = time.monotonic() + request.get('exitTimeout', 2)
            while exit_code is None and time.monotonic() < deadline:
                exited, status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    exit_code = os.waitstatus_to_exitcode(status)
                else:
                    drain(.05)
            if exit_code != request.get('exitCode', 0):
                missing.append(f'child exit {request.get("exitCode", 0)}; got {exit_code}')
        report(request, f'missing={missing}, unexpected={forbidden}' if missing or forbidden else None)
        if args.check and (missing or forbidden):
            sys.exit(1)
        if request.get('quit'): break
finally:
    if exit_code is None:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    os.close(fd)
    if trace: trace.close()
