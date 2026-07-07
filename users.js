// users.js
// User accounts, password hashing, and per-table CRUD permissions.
// Stored in data/users.json. A default "admin" account is created on
// first run (username: admin / password: admin123 — change it!).

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    const admin = {
      id: 1,
      username: 'admin',
      passwordHash: bcrypt.hashSync('admin123', 10),
      isAdmin: true,
      permissions: {},
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [admin], nextId: 2 }, null, 2));
  }
}

function load() {
  ensure();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function persist(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function getAll() {
  return load().users;
}

function getById(id) {
  return load().users.find(u => String(u.id) === String(id));
}

function getByUsername(username) {
  return load().users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
}

function verifyPassword(username, password) {
  const user = getByUsername(username);
  if (!user) return null;
  return bcrypt.compareSync(password || '', user.passwordHash) ? user : null;
}

function countAdmins(data) {
  return data.users.filter(u => u.isAdmin).length;
}

function createUser({ username, password, isAdmin, permissions }) {
  if (!username || !username.trim()) throw new Error('Username is required.');
  if (!password || password.length < 4) throw new Error('Password must be at least 4 characters.');
  const data = load();
  if (data.users.some(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
    throw new Error(`A user named "${username.trim()}" already exists.`);
  }
  const user = {
    id: data.nextId++,
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    isAdmin: !!isAdmin,
    permissions: permissions || {},
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  persist(data);
  return user;
}

function updateUser(id, { username, password, isAdmin, permissions }) {
  const data = load();
  const user = data.users.find(u => String(u.id) === String(id));
  if (!user) throw new Error('Unknown user.');
  if (username && username.trim()) {
    if (data.users.some(u => u.id !== user.id && u.username.toLowerCase() === username.trim().toLowerCase())) {
      throw new Error(`A user named "${username.trim()}" already exists.`);
    }
    user.username = username.trim();
  }
  if (password) {
    if (password.length < 4) throw new Error('Password must be at least 4 characters.');
    user.passwordHash = bcrypt.hashSync(password, 10);
    user.mustChangePassword = false;
  }
  const wasAdmin = user.isAdmin;
  user.isAdmin = !!isAdmin;
  if (wasAdmin && !user.isAdmin && countAdmins(data) === 0) {
    throw new Error('Cannot remove the last administrator.');
  }
  user.permissions = permissions || user.permissions || {};
  persist(data);
  return user;
}

function deleteUser(id) {
  const data = load();
  const user = data.users.find(u => String(u.id) === String(id));
  if (!user) throw new Error('Unknown user.');
  if (user.isAdmin && countAdmins(data) <= 1) {
    throw new Error('Cannot delete the last administrator.');
  }
  data.users = data.users.filter(u => String(u.id) !== String(id));
  persist(data);
}

function changeOwnPassword(id, newPassword) {
  const data = load();
  const user = data.users.find(u => String(u.id) === String(id));
  if (!user) throw new Error('Unknown user.');
  if (!newPassword || newPassword.length < 4) throw new Error('Password must be at least 4 characters.');
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  user.mustChangePassword = false;
  persist(data);
  return user;
}

function can(user, entityKey, action) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const perms = (user.permissions || {})[entityKey];
  return !!(perms && perms[action]);
}

module.exports = {
  getAll, getById, getByUsername, verifyPassword,
  createUser, updateUser, deleteUser, changeOwnPassword, can,
};
