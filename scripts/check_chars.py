import os, json, sys
sys.stdout.reconfigure(encoding='utf-8')

root = os.path.join(os.environ['APPDATA'], 'ai-content-studio')
print('Searching in:', root)

for dirpath, dirs, files in os.walk(root):
    for f in files:
        if f == 'character.json':
            cfile = os.path.join(dirpath, f)
            try:
                with open(cfile, encoding='utf-8') as fh:
                    data = json.load(fh)
                name = data.get('name', '?')
                if any(k in name.lower() for k in ['kylie', 'grace', 'sofia']):
                    print('=== CHARACTER:', name, '===')
                    print('ID:', data.get('id'))
                    mp = data.get('masterPrompt', '(empty)')
                    print('masterPrompt:', mp[:500] if mp else '(empty)')
                    refs = data.get('references', [])
                    print(f'References ({len(refs)}):')
                    for r in refs:
                        status = 'ACTIVE' if r.get('isActive') else 'inactive'
                        print(f'  [{status}] {r.get("label","?")} id={r.get("id")}')
                    print()
            except Exception as e:
                print('Error reading', cfile, ':', e)
