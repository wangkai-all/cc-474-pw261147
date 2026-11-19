import path from 'node:path';

export function getBaseDir() {
  return process.env.TV_BASE_DIR ? path.resolve(process.env.TV_BASE_DIR) : process.cwd();
}

export function getDataDir() {
  return process.env.TV_DATA_DIR
    ? path.resolve(process.env.TV_DATA_DIR)
    : path.join(getBaseDir(), 'data');
}

export function getPagesDir() {
  return getDataDir();
}

export function getObjectsDir() {
  return path.join(getDataDir(), 'objects');
}

export function getStagingDir() {
  return path.join(getDataDir(), 'staging');
}

export function getRestoresDir() {
  return path.join(getDataDir(), 'restores');
}

export function getDbFile() {
  return path.join(getDataDir(), 'timevault.db');
}
