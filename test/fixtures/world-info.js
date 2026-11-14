export async function flushWorldInfoSaves() {}

export function createWorldInfoEntry(_name, document) {
    let uid = 0;
    while (Object.hasOwn(document.entries, uid)) uid++;
    const entry = { uid, comment: '', content: '', key: [], keysecondary: [], order: 100, position: 0, disable: false };
    document.entries[uid] = entry;
    return entry;
}

export async function refreshWorldInfoAfterExternalWrite() {}
