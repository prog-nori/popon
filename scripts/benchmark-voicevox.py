#!/usr/bin/env python3
"""Isolated local VOICEVOX memory benchmark; never reads .env or starts the bot."""
import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
parser.add_argument('--memory', default='1g')
parser.add_argument('--output', required=True)
parser.add_argument('--skip-long', action='store_true')
parser.add_argument('--repeats', type=int, default=5)
args = parser.parse_args()
name = 'popon-voicevox-benchmark-' + str(int(time.time()))
report = {'image': args.image, 'memory': args.memory, 'swap': False,
          'cpu_limit': 2, 'speaker': 3, 'tests': []}

def docker(*argv):
    return subprocess.check_output(['docker', *argv], text=True, stderr=subprocess.STDOUT).strip()

def state():
    return json.loads(docker('inspect', name))[0]['State']

def memory():
    try:
        raw = docker('exec', name, 'bash', '-c',
            'for f in /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak '
            '/sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.usage_in_bytes '
            '/sys/fs/cgroup/memory/memory.max_usage_in_bytes '
            '/sys/fs/cgroup/memory/memory.failcnt; do '
            'if [ -r "$f" ]; then echo "$f"; cat "$f"; fi; done')
        return raw
    except subprocess.CalledProcessError:
        return None

base = ''
def request(path, data=None):
    req = urllib.request.Request(base + path, data=data,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read()

try:
    started = time.monotonic()
    docker('run', '-d', '--name', name, '--memory', args.memory,
           '--memory-swap', args.memory, '--cpus', '2',
           '-p', '127.0.0.1::50021', args.image)
    details = json.loads(docker('inspect', name))[0]
    report['host_config'] = {k: details['HostConfig'][k]
        for k in ('Memory', 'MemorySwap', 'NanoCpus')}
    port = details['NetworkSettings']['Ports']['50021/tcp'][0]['HostPort']
    base = 'http://127.0.0.1:' + port
    while time.monotonic() - started < 180:
        try:
            report['version'] = json.loads(request('/version'))
            report['api_ready_seconds'] = time.monotonic() - started
            break
        except Exception:
            if not state()['Running']:
                raise RuntimeError('Container exited before API readiness')
            time.sleep(0.5)
    else:
        raise RuntimeError('API readiness timeout')
    report['startup_memory'] = memory()
    texts = [('short', 'ぽぽん やあ'),
             ('medium', 'ぽぽん こんにちは。今日はみんなでゲームをしましょう。準備ができたら教えてください。'),
             ('long', ('今日はみんなでゲームを楽しみましょう。準備ができたらボイスチャットに参加してください。' * 5)[:200])]
    # First short synthesis is a cold-model warmup; subsequent runs are sequential.
    if args.skip_long:
        texts = texts[:2]
    for index, (label, text) in enumerate([texts[0]] + texts * args.repeats):
        report['in_progress'] = {'index': index, 'label': label, 'characters': len(text)}
        begin = time.monotonic()
        query = request('/audio_query?' + urllib.parse.urlencode(
            {'text': text, 'speaker': 3}), b'')
        queried = time.monotonic()
        wav = request('/synthesis?speaker=3', query)
        end = time.monotonic()
        row = {'index': index, 'label': 'warmup' if index == 0 else label,
               'characters': len(text), 'query_seconds': queried - begin,
               'synthesis_seconds': end - queried, 'total_seconds': end - begin,
               'wav_bytes': len(wav), 'memory': memory()}
        if index == 0:
            report['first_speech_ready_seconds'] = end - started
        report['tests'].append(row)
        report.pop('in_progress', None)
        print(json.dumps({k: v for k, v in row.items() if k != 'memory'}), flush=True)
except Exception as exc:
    report['error'] = repr(exc)
finally:
    try:
        report['final_state'] = state()
        report['final_memory'] = memory() if report['final_state']['Running'] else None
        report['logs'] = docker('logs', '--tail', '60', name)
    except Exception as exc:
        report['inspection_error'] = repr(exc)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    subprocess.run(['docker', 'rm', '-f', name], check=False)
    print('Report: ' + args.output, flush=True)
sys.exit(1 if 'error' in report else 0)
