"""Strip metadata from every image in a folder, in place.

Mirrors client/src/lib/stripMetadata.js exactly — byte-level chunk removal, no re-encoding — so
files already saved to disk get the same treatment as anything downloaded from now on.

Why it matters: a Nano Banana Pro PNG carries a 7.6 KB `caBX` chunk holding a C2PA credential
CRYPTOGRAPHICALLY SIGNED BY GOOGLE, declaring the image machine-generated. That is a verifiable
attestation, not a guessable fingerprint. Plus an XMP packet and an IPTC profile.

    python tools/clean_image_folder.py <folder>            report only
    python tools/clean_image_folder.py <folder> --write    strip in place
"""
import pathlib
import struct
import sys

# Same allowlist as the JS: anything not listed is dropped, so a new metadata chunk type
# defaults to being removed rather than silently shipped.
PNG_KEEP = {
    b'IHDR', b'PLTE', b'IDAT', b'IEND',
    b'tRNS', b'gAMA', b'cHRM', b'sRGB', b'iCCP',
    b'sBIT', b'bKGD', b'hIST', b'pHYs', b'sPLT',
}
JPEG_DROP = {0xE1, 0xEB, 0xFE}   # APP1 (EXIF/XMP), APP11 (JUMBF/C2PA), COM


def strip_png(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None, 0
    out, off, removed = [data[:8]], 8, 0
    while off + 12 <= len(data):
        length = struct.unpack('>I', data[off:off + 4])[0]
        ctype = data[off + 4:off + 8]
        end = off + 12 + length
        if end > len(data):
            break
        if ctype in PNG_KEEP:
            out.append(data[off:end])
        else:
            removed += 1
        off = end
        if ctype == b'IEND':
            break
    return (b''.join(out), removed) if removed else (None, 0)


def strip_jpeg(data):
    if data[:2] != b'\xff\xd8':
        return None, 0
    out, off, removed = [data[:2]], 2, 0
    while off + 4 <= len(data):
        if data[off] != 0xFF:
            break
        marker = data[off + 1]
        if marker == 0xDA:                 # start of scan — rest is image data
            out.append(data[off:])
            off = len(data)
            break
        size = struct.unpack('>H', data[off + 2:off + 4])[0]
        end = off + 2 + size
        if size < 2 or end > len(data):
            break
        if marker in JPEG_DROP:
            removed += 1
        else:
            out.append(data[off:end])
        off = end
    if off < len(data):
        out.append(data[off:])
    return (b''.join(out), removed) if removed else (None, 0)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    folder = pathlib.Path(sys.argv[1])
    write = '--write' in sys.argv
    if not folder.is_dir():
        print(f'not a folder: {folder}')
        return

    files = sorted(p for p in folder.rglob('*') if p.suffix.lower() in ('.png', '.jpg', '.jpeg'))
    total_saved = cleaned = 0

    for f in files:
        data = f.read_bytes()
        out, removed = (strip_png(data) if f.suffix.lower() == '.png' else strip_jpeg(data))
        if not out:
            continue
        cleaned += 1
        total_saved += len(data) - len(out)
        if write:
            f.write_bytes(out)

    print(f'images scanned : {len(files)}')
    print(f'carried metadata: {cleaned}')
    print(f'bytes removed  : {total_saved:,}')
    if not write:
        print()
        print('report only — re-run with --write to strip in place')


if __name__ == '__main__':
    main()
