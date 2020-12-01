import { Coord, ConstellationBranch } from './size';

export interface WasmEnv {
    [func_name: string]: (...args: any[]) => any;
}

interface WorkerHandle {
    worker: Worker;
    processing: boolean;
    saved_data: any;
}

export class WasmInterface {
    private workers: WorkerHandle[] = [];

    constructor(private num_workers: number = 4) {}

    init(env: WasmEnv): Promise<void> {
        let num_complete = 0;
        const star_promise: Promise<string[]> = fetch('/stars').then(star_result => star_result.json());
        const wasm_promise = fetch('./one-lib/zig-cache/lib/one-math.wasm').then(response => response.arrayBuffer());

        return new Promise((resolve, reject) => {
            Promise.all([star_promise, wasm_promise]).then(([stars, wasm_buffer]) => {
                const range_size = Math.floor(stars.length / this.num_workers);
                for (let i = 0; i < this.num_workers; i++) {
                    const worker = new Worker('./dist/worker.js');
                    const start_index = range_size * i;
                    const end_index = i === this.num_workers - 1 ? stars.length : start_index + range_size;
                    const worker_star_data = stars.slice(start_index, end_index).join('\n');
                    // Add the new worker to the list of workers
                    this.workers.push({
                        worker,
                        processing: false,
                        saved_data: {},
                    });

                    // Receive the worker's messages
                    worker.onmessage = message => {
                        if (message.data.type === 'INIT_COMPLETE') {
                            num_complete += 1;
                            console.log(`${num_complete} workers initialized`);
                            if (num_complete === this.num_workers) {
                                // console.log('finishing initializing');
                                resolve();
                            }
                        } else if (message.data.type === 'drawPointWasm') {
                            env.drawPoints(message.data.points);
                            this.workers[i].processing = false;
                            this.workers[i].saved_data = {
                                ...this.workers[i].saved_data,
                                projection_result_ptr: message.data.result_ptr,
                                projection_result_len_ptr: message.data.result_len_ptr,
                            };
                            // env.drawPointWasm(message.data.x, message.data.y, message.data.brightness);
                        } else if (message.data.type === 'findWaypoints') {
                            this.workers[i].processing = false;
                            this.workers[i].saved_data.waypoints = message.data.waypoints;
                        }
                    };

                    // Initialize the worker with the star range to process and the WASM env
                    worker.postMessage({
                        type: 'INIT',
                        wasm_buffer,
                        stars: worker_star_data,
                    });
                }
            });
        });
    }

    projectStars({ latitude, longitude }: Coord, timestamp: number): Promise<void> {
        for (const handle of this.workers) {
            handle.processing = true;
            handle.worker.postMessage({
                type: 'PROJECT',
                latitude,
                longitude,
                timestamp: BigInt(timestamp),
                result_len_ptr: handle.saved_data.projection_result_len_ptr,
                result_ptr: handle.saved_data.projection_result_ptr,
            });
        }

        return new Promise((resolve, reject) => {
            const check_if_done = () => {
                for (const handle of this.workers) {
                    if (handle.processing) {
                        window.requestAnimationFrame(check_if_done);
                        return;
                    }
                }
                resolve();
            };
            window.requestAnimationFrame(check_if_done);
        });
    }

    projectConstellationBranch(branches: ConstellationBranch[], location: Coord, timestamp: number) {
        // const branches_ptr = this.allocArray(branches, sizedConstellationBranch);
        // const location_ptr = this.allocObject(location, sizedCoord);
        // (this.instance.exports.projectConstellation as any)(branches_ptr, branches.length, location_ptr, BigInt(timestamp));
    }

    findWaypoints(start: Coord, end: Coord): Promise<Coord[]> {
        let waypoint_worker: WorkerHandle;
        for (let i = 0; i < this.workers.length; i += 1) {
            // Find the first non-processing worker
            if (!this.workers[i].processing) {
                waypoint_worker = this.workers[i];
                break;
            }
            if (i === this.workers.length - 1) {
                // Loop forever until one is found
                i = -1;
            }
        }
        waypoint_worker!.processing = true;
        waypoint_worker!.worker.postMessage({
            type: 'findWaypoints',
            start,
            end,
        });
        return new Promise((resolve, reject) => {
            const check_if_done = () => {
                if (waypoint_worker.processing) {
                    window.requestAnimationFrame(check_if_done);
                    return;
                }
                resolve(waypoint_worker.saved_data.waypoints);
                delete waypoint_worker.saved_data.waypoints;
            };
            window.requestAnimationFrame(check_if_done);
        });
    }
}