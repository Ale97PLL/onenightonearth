const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Pixel = packed struct {
    r: u8 = 0,
    g: u8 = 0,
    b: u8 = 0,
    a: u8 = 0,

    pub fn rgb(r: u8, g: u8, b: u8) Pixel {
        return Pixel{ .r = r, .g = g, .b = b, .a = 255 };
    }

};

pub const Point = packed struct {
    x: f32,
    y: f32,

    fn getDist(self: Point, other: Point) f32 {
        return std.math.sqrt(std.math.pow(f32, self.x - other.x, 2.0) + std.math.pow(f32, self.y - other.y, 2.0));
    }
};

pub const Canvas = struct {
    pub const Settings = packed struct {
        width: u32,
        height: u32,
        background_radius: f32,
        zoom_factor: f32,
        draw_north_up: bool,
    };

    data: []Pixel,
    settings: Settings,

    pub fn init(allocator: *Allocator, settings: Settings) !Canvas {
        var canvas: Canvas = undefined;
        canvas.settings = settings;
        canvas.data = try allocator.alloc(Pixel, canvas.settings.width * canvas.settings.height);
        for (canvas.data) |*p| {
            p.* = Pixel{};
        }
        return canvas;
    }

    pub fn translatePoint(self: *Canvas, pt: Point) ?Point {
        const center = Point{
            .x = @intToFloat(f32, self.settings.width) / 2.0,
            .y = @intToFloat(f32, self.settings.height) / 2.0,
        };

        // A multiplier used to convert a coordinate between [-1, 1] to a coordinate on the actual canvas, taking into
        // account the rendering modifiers that can change based on the user zooming in/out or the travelling moving across poles
        const direction_modifier: f32 = if (self.settings.draw_north_up) 1.0 else -1.0;
        const translate_factor: f32 = direction_modifier * self.settings.background_radius * self.settings.zoom_factor;

        const translated_point = Point{
            .x = center.x + (translate_factor * pt.x),
            .y = center.y - (translate_factor * pt.y)
        };

        return if (translated_point.getDist(center) <= self.settings.background_radius) translated_point else null; 
    }

};