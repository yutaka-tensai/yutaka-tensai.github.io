#!/usr/bin/env python3
"""
harvest_sessions.py - Claude Code の会話ログ（JSONL）から、チームの改善材料を抜き出す

使い方:
    python3 harvest_sessions.py [ログのルート] > ~/session-digest.md
    （ルートの既定値は ~/.claude/projects）

出力はセッションごとの「題名・日時・作業場所・ユーザーの発言・失敗したツール呼び出し」。
ユーザーの言い直し（違う・やめて・そうじゃない 等）には ★ を付ける。
IP アドレスやトークンらしき文字列は伏せ字にするが、完全ではないので
出力は公開リポジトリに置かず、NAS の Obsidian など手元にだけ保存すること。
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.claude/projects'))
MAX = 400

CORRECTION = re.compile(r'違う|ちがう|そうじゃな|やめて|戻して|間違|だめ|ダメ|うまくいかない|動かない|できてない|止まる|エラー')
SECRETS = [
    (re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}\b'), '<IP>'),
    (re.compile(r'\b(?:sk-[\w-]{10,}|ghp_\w{20,}|gho_\w{20,}|xox[bp]-[\w-]{10,})'), '<TOKEN>'),
    (re.compile(r'(?i)(password|passwd|パスワード)\s*[:=]\s*\S+'), r'\1: <REDACTED>'),
]


def clean(text):
    for pattern, repl in SECRETS:
        text = pattern.sub(repl, text)
    text = ' '.join(text.split())
    return text if len(text) <= MAX else text[:MAX] + '…'


def is_injected(text):
    # ハーネスが差し込む定型文は人間の発言ではないので除外する
    return text.startswith(('<command-', '<local-command', '<system-reminder', 'Caveat:', '[Request interrupted'))


def digest(path):
    title, cwd, start, prompts, errors = None, None, None, [], []
    for line in path.open(encoding='utf-8', errors='replace'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        kind = d.get('type')
        if kind == 'ai-title':
            title = d.get('aiTitle') or title
        if kind not in ('user', 'assistant'):
            continue
        start = start or d.get('timestamp')
        cwd = cwd or d.get('cwd')
        if d.get('isSidechain'):
            continue
        content = (d.get('message') or {}).get('content')
        if kind == 'user' and isinstance(content, str) and not is_injected(content):
            prompts.append(content)
        elif kind == 'user' and isinstance(content, list):
            for block in content:
                if block.get('type') == 'tool_result' and block.get('is_error'):
                    body = block.get('content')
                    if isinstance(body, list):
                        body = ' '.join(b.get('text', '') for b in body if isinstance(b, dict))
                    errors.append(str(body))
    if not prompts:
        return None
    out = ['## ' + (title or path.stem), '',
           '- 日時: ' + (start or '?')[:16].replace('T', ' '),
           '- 作業場所: ' + (cwd or '?'),
           '- ファイル: ' + str(path), '', '### ユーザーの発言']
    for p in prompts:
        out.append(('- ★ ' if CORRECTION.search(p) else '- ') + clean(p))
    if errors:
        out += ['', '### 失敗したツール呼び出し（%d件、先頭5件）' % len(errors)]
        out += ['- ' + clean(e) for e in errors[:5]]
    return '\n'.join(out) + '\n'


def main():
    files = sorted(ROOT.glob('*/*.jsonl'), key=lambda p: p.stat().st_mtime)
    sections = [s for s in (digest(f) for f in files) if s]
    print('# セッションダイジェスト（%d件 / %s）\n' % (len(sections), ROOT))
    print('★ = ユーザーが言い直した・不満を示した発言。チームの改善点の候補。\n')
    print('\n'.join(sections))


if __name__ == '__main__':
    main()
