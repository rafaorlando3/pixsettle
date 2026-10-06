import { ulid } from 'ulid'
export type Prefix = 'mer' | 'ord' | 'cks' | 'quo' | 'chg' | 'stl' | 'att' | 'rfc' | 'rct' | 'exc' | 'vrd'
export const newId = (p: Prefix) => `${p}_${ulid()}`
