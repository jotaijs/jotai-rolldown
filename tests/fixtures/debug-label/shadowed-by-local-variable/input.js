import { atom } from "jotai";
export function create() {
  const atom = () => ({});
  const value = atom(0);
  return value;
}
