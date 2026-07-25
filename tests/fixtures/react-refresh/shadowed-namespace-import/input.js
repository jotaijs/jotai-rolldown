import * as jotai from "jotai";
export function create(jotai) {
  const value = jotai.atom(0);
  return value;
}
