import { exists, readFile, writeFile } from 'fs';

export const existsAsync = (path: string | Buffer) =>
  new Promise<boolean>((resolve, reject) => {
    exists(path, exists => {
      resolve(exists);
    });
  });