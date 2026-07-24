"""
recover_login.py -- Lists users and resets password in Kyros Studio local DB.
No emojis used -- safe on Windows cp1252 terminals.

Usage:
    python scripts/recover_login.py
    python scripts/recover_login.py <email> <new_password>
"""
import sys
import os
import sqlite3
import subprocess

# Force UTF-8 output on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

DB_PATH = os.path.join(
    os.environ.get('APPDATA', os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming')),
    'ai-content-studio', 'data', 'saas.db'
)

if not os.path.exists(DB_PATH):
    print("ERROR: DB not found at:", DB_PATH)
    sys.exit(1)

print("OK - Found DB at:", DB_PATH)
print("   Size:", f"{os.path.getsize(DB_PATH):,}", "bytes")

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

rows = conn.execute(
    'SELECT id, email, name, is_admin, is_owner, verified FROM users ORDER BY created_at'
).fetchall()

print("\n=== Users in local DB ===")
print("-" * 70)
for i, u in enumerate(rows, 1):
    role = "OWNER" if u['is_owner'] else ("ADMIN" if u['is_admin'] else "user")
    ver  = "verified" if u['verified'] else "UNVERIFIED"
    print(f"  {i}. {u['email']}  ({u['name']})  [{role}]  [{ver}]")
print("-" * 70)

if not rows:
    print("\nWARNING: No users found.")
    conn.close()
    sys.exit(0)


def make_bcrypt_hash(password, rounds=12):
    """Install bcrypt if needed, then hash the password."""
    try:
        import bcrypt as _bcrypt
    except ImportError:
        print("Installing bcrypt package...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "bcrypt", "-q"])
        import bcrypt as _bcrypt
    hashed = _bcrypt.hashpw(password.encode(), _bcrypt.gensalt(rounds))
    return hashed.decode()


def reset_password(email, new_password):
    user = conn.execute(
        'SELECT id FROM users WHERE LOWER(email) = LOWER(?)', (email,)
    ).fetchone()
    if not user:
        print("\nERROR: No user found with email:", email)
        conn.close()
        sys.exit(1)

    print("\nHashing new password (this takes a few seconds)...")
    pw_hash = make_bcrypt_hash(new_password)
    conn.execute(
        'UPDATE users SET password_hash = ?, verified = 1, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
        (pw_hash, user['id'])
    )
    conn.commit()
    print("\n>>> Password reset OK <<<")
    print("    Email:        ", email)
    print("    New password: ", new_password)
    print("\n    Open Kyros Studio and log in with these credentials.\n")


args = sys.argv[1:]
if len(args) == 2:
    reset_password(args[0], args[1])
elif len(rows) == 1:
    auto_email = rows[0]['email']
    auto_pwd   = "Kyros2026!"
    print("\nSingle user found -- auto-resetting:", auto_email)
    reset_password(auto_email, auto_pwd)
else:
    print("\nTo reset a password run:")
    print("  python scripts/recover_login.py <email> <newpassword>")
    print("\nExample:")
    print(f"  python scripts/recover_login.py {rows[0]['email']} Kyros2026!")
    conn.close()
