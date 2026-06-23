import os, json, sys
sys.stdout.reconfigure(encoding='utf-8')

root = os.path.join(os.environ['APPDATA'], 'ai-content-studio')

NEW_PROMPTS = {
    'Kylie': (
        'Warm bronze-brown smoky eye makeup with elongated foxy eyeliner wing, wispy false lashes, '
        'terracotta blush, and warm nude-mauve lips. Long almond-shaped nails in deep wine/burgundy. '
        'Warm skin tone, consistent facial proportions and skin texture.'
    ),
    'Grace': (
        'Very large-volume figure and curves, matching the body shape, hair color, skin tone, and '
        'makeup exactly from the character reference photos. Long beautiful nails in a color that matches the vibe.'
    ),
    'Sofia': (
        'Very large-volume figure and curves, matching the body shape, hair color, skin tone, and '
        'makeup exactly from the character reference photos. Long beautiful nails in a color that matches the vibe.'
    ),
}

for dirpath, dirs, files in os.walk(root):
    for f in files:
        if f == 'character.json':
            cfile = os.path.join(dirpath, f)
            try:
                with open(cfile, encoding='utf-8') as fh:
                    data = json.load(fh)
                name = data.get('name', '')
                if name in NEW_PROMPTS:
                    old = data.get('masterPrompt', '')
                    data['masterPrompt'] = NEW_PROMPTS[name]
                    with open(cfile, 'w', encoding='utf-8') as fh:
                        json.dump(data, fh, indent=2, ensure_ascii=False)
                    print(f'Updated {name}:')
                    print(f'  OLD: {old[:100]}...')
                    print(f'  NEW: {NEW_PROMPTS[name][:100]}...')
                    print()
            except Exception as e:
                print(f'Error: {cfile}: {e}')

print('Done.')
