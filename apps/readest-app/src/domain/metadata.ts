export interface LanguageMap {
  [key: string]: string;
}

export interface Identifier {
  scheme: string;
  value: string;
}

export interface Contributor {
  name: LanguageMap;
}

export interface Collection {
  name: string;
  position?: string;
}
