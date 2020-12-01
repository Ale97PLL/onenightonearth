import { Renderer } from '../render';
import {
    Coord,
    CanvasPoint,
    sizedCanvasPoint,
    ConstellationBranch,
    WasmPrimative,
    isSimpleAlloc,
    isSimpleSize,
    isComplexSize,
    pointer,
    Allocatable,
    Sized,
    sizedCoord,
} from './size';

let instance: WasmInterface;
// let renderer: Renderer;
let num_stars = 0;

const wasm_log = (msg_ptr: number, msg_len: number) => {
    const message = instance.getString(msg_ptr, msg_len);
    console.log(`[WASM] ${message}`);
};

// consoleLog: wasm_log,
// drawPointWasm,
// drawLineWasm,

onmessage = (event: MessageEvent) => {
    if (event.data.type === 'INIT') {
        // renderer = event.data.renderer;
        WebAssembly.instantiate(event.data.wasm_buffer, {
            env: {
                consoleLog: wasm_log,
            },
        }).then(wasm_result => {
            instance = new WasmInterface(wasm_result.instance);
            instance.initialize(event.data.stars);
            num_stars = event.data.stars.split('\n').length;
            postMessage({ type: 'INIT_COMPLETE' });
        });
    } else if (event.data.type === 'PROJECT') {
        const { latitude, longitude, timestamp } = event.data;
        // Get cached pointers for result length and result points if they exist, otherwise allocate new ones
        const result_len_ptr = event.data.result_len_ptr ?? instance.allocBytes(4);
        const result_ptr = event.data.result_ptr ?? instance.allocBytes(num_stars * sizeOf(sizedCanvasPoint));
        if (event.data.result_ptr == null) {
            console.warn('Allocated array for canvas points');
        }
        const canvas_points = instance.projectStars(latitude, longitude, timestamp, result_len_ptr, result_ptr);
        postMessage({
            type: 'drawPointWasm',
            points: canvas_points,
            // For simplicity, always send the pointers back whether or not they're newly allocated
            result_ptr,
            result_len_ptr,
        });
    } else if (event.data.type === 'findWaypoints') {
        const waypoints = instance.findWaypoints(event.data.start, event.data.end, 75);
        postMessage({
            type: 'findWaypoints',
            waypoints,
        });
    }
};

class WasmInterface {
    constructor(private instance: WebAssembly.Instance) {}

    initialize(stars: string): void {
        const star_ptr = this.allocString(stars);
        (this.instance.exports.initialize as any)(star_ptr, stars.length);
    }

    projectStars(latitude: number, longitude: number, timestamp: BigInt, result_len_ptr: number, result_ptr: number): CanvasPoint[] {
        (this.instance.exports.projectStarsWasm as any)(latitude, longitude, timestamp, result_len_ptr, result_ptr);
        const num_points = this.readPrimative(result_len_ptr, WasmPrimative.u32);
        const points = this.readArray(result_ptr, num_points, sizedCanvasPoint);
        return points;
    }

    findWaypoints(start: Coord, end: Coord, num_waypoints: number = 100): Coord[] {
        const start_ptr = this.allocObject(start, sizedCoord);
        const end_ptr = this.allocObject(end, sizedCoord);
        const result_ptr = (this.instance.exports.findWaypointsWasm as any)(start_ptr, end_ptr, num_waypoints);
        const waypoints = this.readArray(result_ptr, num_waypoints, sizedCoord);
        this.freeBytes(result_ptr, num_waypoints * sizeOf(sizedCoord));
        return waypoints;
    }

    getString(ptr: pointer, len: number): string {
        const message_mem = this.memory.slice(ptr, ptr + len);
        const decoder = new TextDecoder();
        return decoder.decode(message_mem);
    }

    allocPrimative(data: number, size: WasmPrimative): pointer {
        const total_bytes = sizeOfPrimative(size);
        const ptr = this.allocBytes(total_bytes);
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        try {
            this.setPrimative(data_mem, data, size, 0);
        } catch (error) {
            if (error instanceof RangeError) {
                console.error(
                    `RangeError: Could not allocate primative (size = ${total_bytes}) for DataView with size ${data_mem.byteLength}`
                );
            } else {
                throw error;
            }
        }
        return ptr;
    }

    readPrimative(ptr: pointer, size: WasmPrimative): number {
        const total_bytes = sizeOfPrimative(size);
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        return this.getPrimative(data_mem, size) as number;
    }

    allocString(data: string): pointer {
        const ptr = this.allocBytes(data.length);
        const encoder = new TextEncoder();
        const data_mem = new DataView(this.memory, ptr, data.length);
        const encoded_data = encoder.encode(data);

        for (const [index, char] of encoded_data.entries()) {
            data_mem.setUint8(index, char);
        }

        return ptr;
    }

    allocObject<T extends Allocatable>(data: T, size: Sized<T>): pointer {
        const total_bytes = sizeOf(size);
        const ptr = this.allocBytes(total_bytes);
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        this.setObject(data_mem, data, size);
        return ptr;
    }

    readObject<T extends Allocatable>(ptr: pointer, size: Sized<T>): T {
        const total_bytes = sizeOf(size);
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        const result: any = {};
        let current_offset = 0;
        if (isSimpleSize(size)) {
            for (const key in size) {
                const value = this.getPrimative(data_mem, size[key], current_offset);
                result[key] = value;
                current_offset += sizeOfPrimative(size[key]);
            }
        } else if (isComplexSize(size)) {
            for (const key in size) {
                const value = this.getObject(data_mem, size[key], current_offset);
                result[key] = value;
                current_offset += sizeOf(size[key]);
            }
        }

        return result;
    }

    allocArray<T extends Allocatable>(data: T[], size: Sized<T>): pointer {
        const item_bytes = sizeOf(size);
        const total_bytes = item_bytes * data.length;
        const ptr = this.allocBytes(total_bytes);
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        let current_offset = 0;
        for (const item of data) {
            current_offset = this.setObject(data_mem, item, size, current_offset);
        }

        return ptr;
    }

    readArray<T extends Allocatable>(ptr: pointer, num_items: number, size: Sized<T>): T[] {
        const total_bytes = sizeOf(size) * num_items;
        const data_mem = new DataView(this.memory, ptr, total_bytes);
        let current_offset = 0;
        const result_array: T[] = new Array(num_items);
        if (isSimpleSize(size)) {
            for (let index = 0; index < num_items; index += 1) {
                const result: any = {};
                for (const key in size) {
                    const value = this.getPrimative(data_mem, size[key], current_offset);
                    result[key] = value;
                    current_offset += sizeOfPrimative(size[key]);
                }
                result_array[index] = result;
            }
        } else if (isComplexSize(size)) {
            for (let index = 0; index < num_items; index += 1) {
                const result: any = {};
                for (const key in size) {
                    const value = this.getObject(data_mem, size[key], current_offset);
                    result[key] = value;
                    current_offset += sizeOf(size[key]);
                }
                result_array[index] = result;
            }
        }

        return result_array;
    }

    allocBytes(num_bytes: number): pointer {
        return (this.instance.exports as any)._wasm_alloc(num_bytes);
    }

    freeBytes(location: pointer, num_bytes: number): void {
        (this.instance.exports as any)._wasm_free(location, num_bytes);
    }

    setObject<T extends Allocatable>(mem: DataView, data: T, type: Sized<T>, offset = 0): number {
        let current_offset = offset;
        if (isSimpleAlloc(data)) {
            if (isSimpleSize(type)) {
                for (const key in data) {
                    this.setPrimative(mem, data[key], type[key], current_offset);
                    current_offset += sizeOfPrimative(type[key]);
                }
            }
        } else {
            if (isComplexSize(type)) {
                for (const key in data) {
                    this.setObject(mem, data[key] as Allocatable, type[key], current_offset);
                    current_offset += sizeOf(type[key]);
                }
            }
        }
        return current_offset;
    }

    getObject<T extends Allocatable>(mem: DataView, type: Sized<T>, offset = 0): T {
        let result: any = {};
        let current_offset = offset;
        if (isSimpleSize(type)) {
            for (const key in type) {
                const val = this.getPrimative(mem, type[key], current_offset);
                result[key] = val;
                current_offset += sizeOfPrimative(type[key]);
            }
        }
        if (isComplexSize(type)) {
            for (const key in type) {
                const val = this.getObject(mem, type[key], current_offset);
                result[key] = val;
                current_offset += sizeOf(type[key]);
            }
        }
        return result;
    }

    private setPrimative(mem: DataView, value: number, type: WasmPrimative, offset = 0) {
        switch (type) {
            case WasmPrimative.u8: {
                mem.setUint8(offset, value);
                break;
            }
            case WasmPrimative.u16: {
                mem.setUint16(offset, value, true);
                break;
            }
            case WasmPrimative.u32: {
                mem.setUint32(offset, value, true);
                break;
            }
            case WasmPrimative.u64: {
                mem.setBigUint64(offset, BigInt(value), true);
                break;
            }
            case WasmPrimative.i8: {
                mem.setInt8(offset, value);
                break;
            }
            case WasmPrimative.i16: {
                mem.setInt16(offset, value, true);
                break;
            }
            case WasmPrimative.i32: {
                mem.setInt32(offset, value, true);
                break;
            }
            case WasmPrimative.i64: {
                mem.setBigInt64(offset, BigInt(value), true);
                break;
            }
            case WasmPrimative.f32: {
                mem.setFloat32(offset, value, true);
                break;
            }
            case WasmPrimative.f64: {
                mem.setFloat64(offset, value, true);
                break;
            }
        }
    }

    private getPrimative(mem: DataView, type: WasmPrimative, offset = 0): number | BigInt {
        switch (type) {
            case WasmPrimative.u8: {
                return mem.getUint8(offset);
            }
            case WasmPrimative.u16: {
                return mem.getUint16(offset, true);
            }
            case WasmPrimative.u32: {
                return mem.getUint32(offset, true);
            }
            case WasmPrimative.u64: {
                return mem.getBigUint64(offset, true);
            }
            case WasmPrimative.i8: {
                return mem.getInt8(offset);
            }
            case WasmPrimative.i16: {
                return mem.getInt16(offset, true);
            }
            case WasmPrimative.i32: {
                return mem.getInt32(offset, true);
            }
            case WasmPrimative.i64: {
                return mem.getBigInt64(offset, true);
            }
            case WasmPrimative.f32: {
                return mem.getFloat32(offset, true);
            }
            case WasmPrimative.f64: {
                return mem.getFloat64(offset, true);
            }
        }
    }

    get memory(): ArrayBuffer {
        return (this.instance.exports.memory as any).buffer;
    }
}

const sizeOfPrimative = (data: WasmPrimative): number => {
    switch (data) {
        case WasmPrimative.u8:
        case WasmPrimative.i8:
            return 1;
        case WasmPrimative.u16:
        case WasmPrimative.i16:
            return 2;
        case WasmPrimative.u32:
        case WasmPrimative.i32:
        case WasmPrimative.f32:
            return 4;
        case WasmPrimative.u64:
        case WasmPrimative.i64:
        case WasmPrimative.f64:
            return 8;
        default:
            return data;
    }
};

const sizeOf = <T extends Allocatable>(type: Sized<T>): number => {
    let size = 0;
    if (isSimpleSize(type)) {
        for (const key in type) {
            if (type.hasOwnProperty(key)) {
                size += sizeOfPrimative(type[key]);
            }
        }
    } else if (isComplexSize(type)) {
        for (const key in type) {
            if (type.hasOwnProperty(key)) {
                size += sizeOf(type[key]);
            }
        }
    }
    return size;
};