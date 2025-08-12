const getRandom = (ext = '') => {
  return `${Math.floor(Math.random() * 10000000000000000)}${ext}`;
};

const getExtension = (buffer) => {
  
  const magicNumbers = {
    jpg: Buffer.from([0xff, 0xd8, 0xff]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff]),
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mp4: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    mp3: Buffer.from([0x49, 0x44, 0x33]),
    m4a: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]),
  };

  if (!Buffer.isBuffer(buffer)) {
    return 'unknown'; 
  }

  for (const [ext, magic] of Object.entries(magicNumbers)) {
    if (buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic)) {
      return ext;
    }
  }
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
  };
  const mimetype = buffer.mimetype || 'application/octet-stream';
  return mimeToExt[mimetype] || 'unknown';
};

module.exports = { getRandom, getExtension };