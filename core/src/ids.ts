import { ulid } from 'ulid'
export type Prefix = 'mer' | 'ord' | 'cks' | 'quo' | 'chg' | 'stl' | 'att' | 'rfc' | 'rct'
export const newId = (p: Prefix) => `${p}_${ulid()}`
