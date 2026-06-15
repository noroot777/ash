import { nanoid } from "nanoid";

export const id = () => nanoid(12);
export const now = () => new Date().toISOString();
