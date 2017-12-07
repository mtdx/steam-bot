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

export const writeFileAsync = (filename: string, data: any) =>
  new Promise((resolve, reject) => {
    writeFile(filename, data, err => {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  });

export const waitAsync = (seconds = Math.random()) =>
  new Promise(resolve => {
    setTimeout(resolve, seconds * 1000);
  });
