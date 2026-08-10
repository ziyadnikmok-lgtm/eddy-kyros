#!/usr/bin/env python3
"""Push files to Eddy's branch WITHOUT silently deleting his work.

WHY THIS EXISTS
    This repo and `friend/share-clean` have unrelated histories — 742 local commits are on neither
    side of a common base — so a normal merge is not available and every push here is a whole-file
    copy. A whole-file copy is a silent overwrite: whatever Eddy changed between the last fetch and
    this push is simply gone, with nothing in the output to say so.

    That happened four times on 2026-08-09: a CSS rule, CLAUDE.md, a stale-comment cleanup, and the
    entire "unfinished run survives a restart" feature. Each was caught by reading the diff
    afterwards. Noticing afterwards is not a process.

WHAT IT DOES
    Fetches, then for every file it is about to push it compares HIS version to MINE and reports any
    line that exists on his side and not on mine. That is the exact shape of "I am about to delete
    something of his". It refuses to continue when it finds any, so the failure is loud and lands
    BEFORE the push rather than after.

    Comments and blank lines are ignored: reformatting is not data loss, and flagging it would train
    everyone to pass --force.

USAGE
    python tools/share-push.py client/src/pages/EddyGeneratePage.jsx
    python tools/share-push.py --all-dirty                 # everything git reports as modified
    python tools/share-push.py <files> --message "..."     # commit + push once it is clean
    python tools/share-push.py <files> --force             # overwrite anyway; say why in the message

WHEN IT FLAGS SOMETHING
    Do NOT reach for --force. Copy his version down, re-apply your change on top of it, and run this
    again — a missing anchor then fails loudly instead of reverting him. --force is for when the
    owner has looked at the report and decided his version should go.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
REMOTE, BRANCH = 'friend', 'share-clean'
REF = f'{REMOTE}/{BRANCH}'


def git(*args: str, check: bool = True, cwd: Path | None = None) -> str:
    # encoding is NOT optional here. text=True decodes with the Windows ANSI codepage, and this
    # repo's files contain UTF-8 punctuation -- git show blew up with a UnicodeDecodeError, the
    # exception was swallowed into an empty result, and the guard reported CLEAN on a file it had
    # failed to read. A safety check that fails open is worse than none.
    r = subprocess.run(['git', *args], cwd=str(cwd or REPO), capture_output=True,
                       encoding='utf-8', errors='replace')
    if check and r.returncode:
        raise SystemExit(f'git {" ".join(args)}\n{r.stderr.strip()}')
    return r.stdout


def ascii_only(text: str) -> str:
    """Printable on a cp1252 console. A guard that crashes on its own report does not report."""
    return text.encode('ascii', 'replace').decode('ascii')


def meaningful(line: str) -> bool:
    """Is this line worth protecting? Blank lines and comments are not data loss."""
    t = line.strip()
    if not t:
        return False
    return not re.match(r'^(//|/\*|\*/?|#|<!--)', t)


def his_only(path: str) -> list[str]:
    """Lines on HIS side that are absent from mine -- what a copy would delete."""
    # check=True: an unreadable file must STOP the push, not read as "nothing to lose". The one
    # exception is a file that genuinely does not exist on his branch, which git reports distinctly.
    r = subprocess.run(['git', 'show', f'{REF}:{path}'], cwd=str(REPO), capture_output=True,
                       encoding='utf-8', errors='replace')
    if r.returncode:
        if 'does not exist' in r.stderr or 'exists on disk, but not in' in r.stderr:
            return []                               # new file on my side; nothing of his to lose
        raise SystemExit(f'Could not read {path} from {REF}: {r.stderr.strip()}')
    theirs = r.stdout
    local = (REPO / path)
    mine = local.read_text(encoding='utf-8', errors='replace') if local.exists() else ''
    # Compared WITHOUT a trailing comma. Adding a key after an existing one in JSON turns
    # `"lint": "eslint src"` into `"lint": "eslint src",` — the same line, reported as a deletion.
    # A guard that cries wolf gets forced past, so the noise matters as much as the misses.
    norm = lambda t: t.strip().rstrip(',')
    mine_set = {norm(l) for l in mine.splitlines()}
    return [l for l in theirs.splitlines() if meaningful(l) and norm(l) not in mine_set]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--all-dirty', action='store_true', help='every file git reports as modified')
    ap.add_argument('--message', '-m')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-dist', action='store_true', help='skip the built bundle')
    args = ap.parse_args()

    print(f'  fetching {REF} ...')
    git('fetch', REMOTE, BRANCH, '-q')

    files = list(args.files)
    if args.all_dirty:
        files += [l[3:] for l in git('status', '--porcelain').splitlines()
                  if l[:2] in (' M', 'M ', 'MM', '??') and not l[3:].startswith('client/dist')]
    files = sorted({f for f in files if f})
    if not files:
        raise SystemExit('Nothing to push. Name files, or pass --all-dirty.')

    # --- the check ------------------------------------------------------------------------------
    losses: dict[str, list[str]] = {}
    for f in files:
        lost = his_only(f)
        if lost:
            losses[f] = lost

    if losses:
        print('\n  !!  THIS PUSH WOULD DELETE WORK THAT IS ON HIS BRANCH:\n')
        for f, lines in losses.items():
            print('    ' + ascii_only(f) + f'  -- {len(lines)} line(s) only on his side')
            for l in lines[:12]:
                # The ECHOED line comes from source and can hold any character; the console is
                # cp1252 and died on an arrow. Sanitising here rather than at the call site,
                # because every one of these strings is someone else's text, not mine.
                print('      | ' + ascii_only(l[:118]))
            if len(lines) > 12:
                print(f'      | ... {len(lines) - 12} more')
            print()
        if not args.force:
            print('  Refusing. Copy his version down, re-apply your change on top, and run again.')
            print(f'    git show {REF}:<file> > <file>')
            print('  Use --force only when the owner has seen this list and decided.')
            sys.exit(2)
        print('  --force given: overwriting anyway.\n')
    else:
        print(f'  clean -- nothing of his is lost across {len(files)} file(s)')

    if not args.message:
        print('\n  No --message, so nothing was pushed. The check above is what you wanted to see.')
        return

    # --- the push -------------------------------------------------------------------------------
    wt = Path(tempfile.mkdtemp(prefix='share_wt_'))
    try:
        git('worktree', 'add', '--detach', str(wt), REF, '-q')
        for f in files:
            dest = wt / f
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / f, dest)
        if not args.no_dist and (REPO / 'client/dist').is_dir():
            shutil.rmtree(wt / 'client/dist', ignore_errors=True)
            shutil.copytree(REPO / 'client/dist', wt / 'client/dist')
        # Stage the files ACTUALLY NAMED, not a fixed set of directories. The hard-coded list
        # left out docs/, so a spec was copied into the worktree, never staged, and the commit
        # then failed with an empty stderr -- the push reported nothing and did nothing
        # (2026-08-10). A tool that silently drops a file it was handed is worse than no tool.
        git('add', '-A', '--', *files, cwd=wt, check=False)
        if not args.no_dist and (REPO / 'client/dist').is_dir():
            git('add', '-A', '--', 'client/dist', cwd=wt, check=False)
        staged = git('diff', '--cached', '--name-only', cwd=wt).strip()
        if not staged:
            print('  nothing to push -- his branch already matches these files')
            return
        git('commit', '-q', '-m', args.message, cwd=wt)
        print(git('push', REMOTE, f'HEAD:{BRANCH}', cwd=wt).strip() or '  pushed')
    finally:
        git('worktree', 'remove', '--force', str(wt), check=False)
        git('worktree', 'prune', check=False)


if __name__ == '__main__':
    main()
