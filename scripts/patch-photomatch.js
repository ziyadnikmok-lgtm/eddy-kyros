const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../client/src/pages/PhotoMatchPage.jsx');
let content = fs.readFileSync(filePath, 'utf8');

const INSERTION_MARKER = `  }, [applyFile]);`;

// We want to insert AFTER the paste useEffect's closing line
// Find the paste listener block and insert after it
const pasteBlock = `    window.addEventListener('paste', onPaste);\r\n    return () => window.removeEventListener('paste', onPaste);\r\n  }, [applyFile]);`;
const pasteBlockLF = `    window.addEventListener('paste', onPaste);\n    return () => window.removeEventListener('paste', onPaste);\n  }, [applyFile]);`;

const newBlock = `\n\n  // "Use as source" fired from feed panel hover/right-click on a generated image\n  useEffect(() => {\n    const onUseAsSource = (e) => {\n      const { base64, mimeType, name } = e.detail || {};\n      if (!base64 || !mimeType) return;\n      const binary = atob(base64);\n      const bytes = new Uint8Array(binary.length);\n      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n      const ext = mimeType.split('/')[1] || 'png';\n      const filename = name || \`source.\${ext}\`;\n      applyFile(new File([bytes], filename, { type: mimeType }));\n    };\n    window.addEventListener('kyros:use-as-source', onUseAsSource);\n    return () => window.removeEventListener('kyros:use-as-source', onUseAsSource);\n  }, [applyFile]);`;

let patched = false;
if (content.includes(pasteBlock)) {
  content = content.replace(pasteBlock, pasteBlock + newBlock);
  patched = true;
} else if (content.includes(pasteBlockLF)) {
  content = content.replace(pasteBlockLF, pasteBlockLF + newBlock);
  patched = true;
}

if (patched) {
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Patched PhotoMatchPage.jsx - use-as-source listener added');
} else {
  console.log('❌ Target block not found. Current unique markers in file:');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('applyFile') && line.includes('useEffect')) {
      console.log(`  Line ${i + 1}: ${line.trim()}`);
    }
  });
}
