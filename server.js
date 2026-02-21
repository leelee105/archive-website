const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Ensure directories and data file exist
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ folders: [], files: [] }), 'utf8');
  }
}

// Read data from file
function readData() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { folders: [], files: [] };
  }
}

// Write data to file
function writeData(data) {
  ensureDirs();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 0), 'utf8');
}

// Generate unique ID
function id() {
  return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Public route: get full structure
app.get('/api/structure', (req, res) => {
  const data = readData();
  res.json({ folders: data.folders || [], files: data.files || [] });
});

// Public route: get file content
app.get('/api/file/:id', (req, res) => {
  const data = readData();
  const file = (data.files || []).find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  
  const filePath = path.join(UPLOADS_DIR, file.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', disposition + '; filename="' + (file.name || 'download').replace(/"/g, '%22') + '"');
  
  if (file.type) {
    const mime = {
      jpg: 'image/jpeg', 
      jpeg: 'image/jpeg', 
      png: 'image/png', 
      gif: 'image/gif',
      webp: 'image/webp', 
      bmp: 'image/bmp', 
      svg: 'image/svg+xml'
    }[file.type.toLowerCase()];
    if (mime) res.setHeader('Content-Type', mime);
  }
  
  res.sendFile(filePath);
});

// Key required: create folder
app.post('/api/folder', (req, res) => {
  const { name, parentId } = req.body || {};
  const n = (name || '').trim();
  if (!n) return res.status(400).json({ error: 'Name required' });
  
  let data;
  try {
    data = readData();
  } catch (e) {
    return res.status(500).json({ error: 'Could not read data' });
  }
  
  if (!Array.isArray(data.folders)) data.folders = [];
  const folder = { id: id(), name: n, parentId: parentId || null };
  data.folders.push(folder);
  
  try {
    writeData(data);
  } catch (e) {
    return res.status(500).json({ error: 'Could not save folder' });
  }
  
  res.json(folder);
});

// Key required: upload file(s) - SINGLE UPLOAD ROUTE
const memStorage = multer.memoryStorage();
const uploadMem = multer({ storage: memStorage });

app.post('/api/upload', uploadMem.any(), (req, res) => {
  ensureDirs();
  const folderId = (req.body && req.body.folderId) !== undefined ? req.body.folderId : null;
  const data = readData();
  data.files = data.files || [];
  const added = [];
  
  (req.files || []).forEach(function (file) {
    const fileId = id();
    const ext = (path.extname(file.originalname) || '').slice(1).toLowerCase();
    fs.writeFileSync(path.join(UPLOADS_DIR, fileId), file.buffer);
    const meta = {
      id: fileId,
      name: file.originalname || 'Unnamed',
      size: file.size,
      folderId: folderId,
      type: ext || null
    };
    data.files.push(meta);
    added.push(meta);
  });
  
  if (added.length === 0) return res.status(400).json({ error: 'No files' });
  writeData(data);
  res.json({ files: added });
});

// Key required: update folder (rename / move)
app.put('/api/folder/:id', (req, res) => {
  const data = readData();
  const folder = (data.folders || []).find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  
  if (req.body.name !== undefined) {
    folder.name = String(req.body.name).trim() || folder.name;
  }
  if (req.body.parentId !== undefined) {
    folder.parentId = req.body.parentId || null;
  }
  
  writeData(data);
  res.json(folder);
});

// Key required: update file (rename / move)
app.put('/api/file/:id', (req, res) => {
  const data = readData();
  const file = (data.files || []).find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  
  if (req.body.name !== undefined) {
    file.name = String(req.body.name).trim() || file.name;
    const ext = path.extname(file.name).slice(1).toLowerCase();
    if (ext) file.type = ext;
  }
  if (req.body.folderId !== undefined) {
    file.folderId = req.body.folderId || null;
  }
  
  writeData(data);
  res.json(file);
});

// Key required: delete folder (and all contents)
function collectFolderIds(data, parentId) {
  const out = [parentId];
  (data.folders || [])
    .filter(f => f.parentId === parentId)
    .forEach(f => out.push(...collectFolderIds(data, f.id)));
  return out;
}

app.delete('/api/folder/:id', (req, res) => {
  const data = readData();
  if (!(data.folders || []).some(f => f.id === req.params.id)) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  
  const ids = collectFolderIds(data, req.params.id);
  const removedFiles = (data.files || []).filter(f => ids.includes(f.folderId));
  
  removedFiles.forEach(f => {
    const fp = path.join(UPLOADS_DIR, f.id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  
  data.files = (data.files || []).filter(f => !ids.includes(f.folderId));
  data.folders = (data.folders || []).filter(f => !ids.includes(f.id));
  writeData(data);
  res.status(204).end();
});

// Key required: delete file
app.delete('/api/file/:id', (req, res) => {
  const data = readData();
  const file = (data.files || []).find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  
  data.files = data.files.filter(f => f.id !== req.params.id);
  writeData(data);
  
  const filePath = path.join(UPLOADS_DIR, req.params.id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  
  res.status(204).end();
});

// Serve static files from public directory
app.use(express.static(__dirname));

// Start server
ensureDirs();
app.listen(PORT, () => {
  console.log(`Archive server running at http://localhost:${PORT}`);
});