import { Md5HashBrowserLive } from './browser';
import { Md5HashServerLive } from './server';

export const Md5HashLayer = typeof window === 'undefined' ? Md5HashServerLive : Md5HashBrowserLive;
