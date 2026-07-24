const http = require('http');
http.get('http://localhost:3001/api/gallery', (r) => {
  let d = '';
  r.on('data', (c) => d += c);
  r.on('end', () => {
    const j = JSON.parse(d);
    console.log('Top keys:', Object.keys(j));
    console.log('success:', j.success);
    console.log('data type:', typeof j.data, Array.isArray(j.data));
    if (j.data) {
      if (Array.isArray(j.data)) {
        console.log('array count:', j.data.length);
        if (j.data[0]) console.log('first item keys:', Object.keys(j.data[0]));
      } else {
        console.log('data keys:', Object.keys(j.data));
        if (j.data.items) {
          console.log('items count:', j.data.items.length);
          if (j.data.items[0]) console.log('first item keys:', Object.keys(j.data.items[0]));
        } else if (j.data.images) {
          console.log('images count:', j.data.images.length);
        }
      }
    }
  });
}).on('error', (e) => console.error(e.message));
