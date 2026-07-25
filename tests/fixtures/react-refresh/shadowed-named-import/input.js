import { atom } from "jotai";
export function create(atom) {
  const value = atom(0);
  return value;
}
