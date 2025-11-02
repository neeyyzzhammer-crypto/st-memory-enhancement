// 生成或获取设备ID（从用户代码中提取）

function loadFontAwesome() {
    // const fontAwesomeLink = document.createElement('link');
    // fontAwesomeLink.rel = 'stylesheet';
    // fontAwesomeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'; // 替换为 Font Awesome CDN 链接
    // document.head.appendChild(fontAwesomeLink);
}

export function compareDataDiff(target, source) {
    const diff = {};
    for (const key of Object.keys(target)) {
        if (target[key] !== source[key]) {
            diff[key] = target[key];
        }
    }
    return diff;
}

export function compareDataSame(target, source) {
    const same = {};
    for (const key of Object.keys(target)) {
        if (target[key] === source[key]) {
            same[key] = target[key];
        }
    }
}

export function cssColorToRgba(name, opacity = 1) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).replace(')', `, ${opacity})`);
}

/**
 * 创建一个只读属性
 * @param {object} obj 要在其上定义属性的对象
 * @param {string} propertyName 属性名称
 * @param {function} getter 获取属性值的函数
 */
export function readonly(obj, propertyName, getter) {
    Object.defineProperty(obj, propertyName, {
        get: getter,
        set(value) {
            throw new Error(`${propertyName} 属性是只读的，不允许写入。`);
        }
    });
}

let step = 0;  // 保证每次调用该函数时绝对能生成不一样的随机数
function stepRandom(bias = step) {
    // console.log('stepRandom');
    let r = 100000 / (100000 / Math.random() + bias++);
    return r;
}

/**
 * 生成一个随机字符串
 * @description 请注意，该函数不适用于安全敏感的场景，在长度低于 12 时有碰撞的风险
 * @description 在 length = 8 时有 0.000023% (1,000,000次实验) 的可能性会出现重复
 * @param length
 * @param bias
 * @param characters
 * @returns {string}
 */
export function generateRandomString(length = 12, bias = step, characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(stepRandom(bias) * characters.length));
    }
    return result;
}

/**
 * 生成一个随机数字
 * @description 请注意，该函数不适用于安全敏感的场景，且在 length = 8 时有 0.00005% (1,000,000次实验) 的可能性会出现重复
 * @param length
 * @param forceLength
 * @returns {number}
 */
export function generateRandomNumber(length = 12, forceLength = true) {
    let randomNumber;

    do {
        randomNumber = Math.floor(stepRandom() * Math.pow(10, length));

        // 如果需要强制长度，确保生成的数字符合要求
        if (forceLength && randomNumber.toString().length < length) {
            randomNumber *= Math.pow(10, length - randomNumber.toString().length);
        }
    } while (forceLength && randomNumber.toString().length !== length);

    return randomNumber;
}

//random一个唯一id加密用
export function generateUid() {
    const rid = `st-${Date.now()}-${generateRandomString(32)}`;
    console.log('生成的唯一ID:', rid);
    return rid;
}

export function generateDeviceId() {
    let deviceId = localStorage.getItem('st_device_id') || generateUid();
    if (!localStorage.getItem('st_device_id')) {
        localStorage.setItem('st_device_id', deviceId);
    }
    return deviceId;
}


let antiShakeTimers = {};
/**
 * 防抖函数，控制某个操作的执行频率
 * @param {string} uid 唯一标识符，用于区分不同的防抖操作
 * @param {number} interval 时间间隔，单位毫秒，在这个间隔内只允许执行一次
 * @returns {boolean} 如果允许执行返回 true，否则返回 false
 */
export function lazy(uid, interval = 100) {
    if (!antiShakeTimers[uid]) {
        antiShakeTimers[uid] = { lastExecutionTime: 0 };
    }
    const timer = antiShakeTimers[uid];
    const currentTime = Date.now();

    if (currentTime - timer.lastExecutionTime < interval) {
        return false; // 时间间隔太短，防抖，不允许执行
    }

    timer.lastExecutionTime = currentTime;
    return true; // 允许执行
}


/**
 * Calculate a stable hash of a string.
 * - Uses SubtleCrypto SHA-256 when available.
 * - Falls back to a fast JS FNV-1a hash in non-secure contexts.
 * Note: Not for security-sensitive use.
 * @param {string} input
 * @param {string} [algorithm='SHA-256'] One of SHA-256, SHA-384, SHA-512 (when supported)
 * @returns {Promise<string>} hex string
 */
export async function calculateStringHash(input, algorithm = 'SHA-256') {
    if (typeof input !== 'string') {
        throw new Error('The input value is not a string.');
    }

    // Fast JS fallback: 32-bit FNV-1a
    const fnv1a32 = (str) => {
        let h = 0x811c9dc5 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            // h *= 16777619 (with 32-bit overflow)
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    };

    const toHex = (buf) => Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    try {
        if (globalThis.crypto?.subtle?.digest) {
            const data = new TextEncoder().encode(input);

            // Try requested algorithm first, then fallbacks commonly supported by browsers.
            const algos = [algorithm, 'SHA-256', 'SHA-384', 'SHA-512'];
            for (const algo of algos) {
                try {
                    const hashBuffer = await crypto.subtle.digest(algo, data);
                    return toHex(hashBuffer);
                } catch (e) {
                    // NotSupportedError -> try next algo
                    if (e && e.name === 'NotSupportedError') continue;
                    throw e;
                }
            }
            // If none worked, drop to JS fallback
        }
    } catch {
        // Ignore and use fallback
    }
    return fnv1a32(input);
}

