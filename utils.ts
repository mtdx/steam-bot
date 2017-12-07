import { exists, readFile, writeFile } from 'fs';

export const existsAsync = (path: string | Buffer) =>
  new Promise<boolean>((resolve, reject) => {
    exists(path, exists => {
      resolve(exists);
    });
  });

  export const readFileAsync = (filename: string) =>
  new Promise<Buffer>((resolve, reject) => {
    readFile(filename, (err, data) => {
      if (err) {
        return reject(err);
      }

      resolve(data);
    });
  });