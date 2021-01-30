interface CanvasOptions {
    width?: number;
    height?: number;
}

export type CanvasSettings = {
    width: number;
    height: number;
    background_radius: number;
    zoom_factor: number;
    draw_north_up: boolean;
};

export class Renderer {
    /**
     * The main canvas is the one that's shown to the user. It's only drawn to in single batches, once the workers
     * have finished drawing everything to the offscreen buffer.
     */
    private main_canvas: HTMLCanvasElement;
    private main_ctx: CanvasRenderingContext2D;

    /**
     * The offscreen canvas gets drawn to continuously by each worker. Once all the workers are done, then the
     * content of this canvas is copied onto the main canvas so that the user can see it.
     */
    private offscreen_canvas: HTMLCanvasElement;
    private offscreen_ctx: CanvasRenderingContext2D;

    private readonly default_width = 700;
    private readonly default_height = 700;

    private settings: CanvasSettings;

    private _settings_did_change = true;

    constructor(canvas_id: string, options?: CanvasOptions) {
        this.main_canvas = document.getElementById(canvas_id) as HTMLCanvasElement;
        this.main_ctx = this.main_canvas.getContext('2d')!;

        this.main_canvas.width = options?.width ?? this.default_width;
        this.main_canvas.height = options?.height ?? this.default_height;

        this.settings = {
            width: this.main_canvas.width,
            height: this.main_canvas.height,
            background_radius: 0.45 * Math.min(this.main_canvas.width, this.main_canvas.height),
            zoom_factor: 1.0,
            draw_north_up: true,
        };

        this.offscreen_canvas = document.createElement('canvas');
        this.offscreen_ctx = this.offscreen_canvas.getContext('2d')!;

        this.offscreen_canvas.width = this.width;
        this.offscreen_canvas.height = this.height;
    }

    drawData(data: Uint8ClampedArray): void {
        try {
            const image_data = new ImageData(data, this.main_canvas.width, this.main_canvas.height);
            this.main_ctx.putImageData(image_data, 0, 0);
        } catch (error) {
            if (error instanceof DOMException) {
                console.error('DOMException in drawPoint: ', error);
            }
        }
    }

    /**
     * Add an event listener to the main canvas.
     * @param event_name
     * @param event_handler
     */
    addEventListener<K extends keyof DocumentEventMap>(event_name: K, event_handler: (e: DocumentEventMap[K]) => void): void {
        this.main_canvas.addEventListener(event_name, (event: any) => {
            event_handler(event);
        });
    }

    getCanvasSettings(): CanvasSettings {
        this._settings_did_change = false;
        return this.settings;
    }

    /**
     * The width of the canvas.
     */
    get width(): number {
        return this.settings.width;
    }

    /**
     * The height of the canvas.
     */
    get height(): number {
        return this.settings.height;
    }

    get background_radius() {
        return this.settings.background_radius;
    }

    set background_radius(r: number) {
        this.settings.background_radius = r;
        this._settings_did_change = true;
    }

    get zoom_factor() {
        return this.settings.zoom_factor;
    }

    set zoom_factor(f: number) {
        console.log('New zoom_factor = ', f);
        this.settings.zoom_factor = f;
        this._settings_did_change = true;
    }

    get draw_north_up() {
        return this.settings.draw_north_up;
    }

    set draw_north_up(d: boolean) {
        this.settings.draw_north_up = d;
        this._settings_did_change = true;
    }

    get settings_did_change() {
        return this._settings_did_change;
    }

    /**
     * The user-facing canvas.
     */
    get canvas() {
        return this.main_canvas;
    }

    get context() {
        return this.offscreen_ctx;
    }
}
