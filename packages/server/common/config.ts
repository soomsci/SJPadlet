import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export function projectRoot(){return existsSync(resolve(process.cwd(),'apps/web'))?process.cwd():resolve(process.cwd(),'../..');}
export function dataPath(path:string){return resolve(projectRoot(),path);}
