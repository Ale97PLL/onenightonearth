const std = @import("std");
const builtin = @import("builtin");

const Allocator = std.mem.Allocator;

const tortie = @import("tortie");
const TortieServer = tortie.TortieServer;
const http = tortie.http;

var static_files = [_]StaticFile{
    StaticFile.init("../web/index.html", .{ .path = "/" }),
    StaticFile.init("star_data.bin", .{ .path = "/stars", .content_type = "octet-stream", .compress = true }),
    StaticFile.init("const_data.bin", .{ .path = "/constellations", .content_type = "octet-stream" }),
    StaticFile.init("const_meta.json", .{ .path = "/constellations/meta", .content_type = "application/json" }),
    StaticFile.init("../web/styles/main.css", .{ .relative_to = "../web" }),
    StaticFile.init("../web/dist/bundle.js", .{ .relative_to = "../web", .compress = true }),
    StaticFile.init("../web/dist/bundle.js.map", .{ .relative_to = "../web", .compress = true }),
    StaticFile.init("../web/styles/main.css", .{ .relative_to = "../web" }),
    StaticFile.init("../web/assets/favicon.ico", .{ .relative_to = "../web" }),
    StaticFile.init("../web/dist/wasm/night-math.wasm", .{ .relative_to = "../web/dist/wasm", .compress = true }),
};

pub const log_level = switch (builtin.mode) {
    .Debug => .debug,
    else => .info,
};

pub const log = std.log.scoped(.night_server);

const StaticFile = struct {
    const InitOptions = struct {
        path: ?[]const u8 = null,
        relative_to: ?[]const u8 = null,
        content_type: ?[]const u8 = null,
        compress: bool = false,
    };

    path: []const u8,
    file_name: []const u8,
    content: ?[]const u8 = null,
    content_type: []const u8 = "text/plain",
    secure_context: bool = true,
    compress: bool = false,
    is_standalone: bool = false,

    fn init(file_name: []const u8, options: InitOptions) StaticFile {
        var path: []const u8 = undefined;
        if (options.path) |path_override| {
            path = path_override;
        } else if (options.relative_to) |relative_to| {
            const start_index = if (std.mem.startsWith(u8, file_name, relative_to)) relative_to.len else 0;
            path = file_name[start_index..];
        } else {
            path = file_name;
        }

        return StaticFile{
            .path = path,
            .file_name = file_name,
            .content_type = options.content_type orelse getMimeType(file_name),
            .compress = options.compress,
        };
    }

    fn deinit(static_file: *StaticFile, allocator: Allocator) void {
        if (!static_file.is_standalone) return;
        allocator.free(static_file.content);
    }

    fn loadContent(static_file: *StaticFile, allocator: Allocator) ![]const u8 {
        static_file.is_standalone = true;
        static_file.compress = false;
        const cwd = std.fs.cwd();

        var file = try cwd.openFile(static_file.file_name, .{});
        defer file.close();

        var content = std.ArrayList(u8).init(allocator);
        var buffer: [1024]u8 = undefined;

        while (true) {
            const bytes_read = try file.readAll(&buffer);
            try content.appendSlice(buffer[0..bytes_read]);

            if (bytes_read < buffer.len) break;
        }

        static_file.content = try content.toOwnedSlice();
        return static_file.content.?;
    }
};

const StaticContent = struct {
    buffer: []const u8,
    file_info: []StaticFile,

    fn init(allocator: Allocator, file_info: []StaticFile) !StaticContent {
        var content: StaticContent = undefined;
        content.file_info = @constCast(file_info);

        const cwd = std.fs.cwd();

        var buffer = try std.ArrayList(u8).initCapacity(allocator, 1024 * file_info.len);
        errdefer buffer.deinit();

        var main_buffer_writer = buffer.writer();
        var compressor = try std.compress.deflate.compressor(allocator, main_buffer_writer, .{ .level = .best_compression });
        defer compressor.deinit();

        const Marker = struct { start: usize, end: usize };

        var file_content_markers = try allocator.alloc(Marker, file_info.len);
        defer allocator.free(file_content_markers);

        var file_buffer: [1024]u8 = undefined;

        for (content.file_info, 0..) |info, index| {
            var file = cwd.openFile(info.file_name, .{}) catch |err| {
                log.err("Error ocurred when trying to open file {s}: {}", .{ info.file_name, err });
                file_content_markers[index] = .{ .start = 0, .end = 0 };
                continue;
            };
            defer file.close();

            const content_start_index = buffer.items.len;
            var reader = std.io.bufferedReader(file.reader());

            while (true) {
                const bytes_read = try reader.read(&file_buffer);
                if (info.compress) {
                    try compressor.writer().writeAll(file_buffer[0..bytes_read]);
                } else {
                    try main_buffer_writer.writeAll(file_buffer[0..bytes_read]);
                }

                if (bytes_read < file_buffer.len) break;
            }

            if (info.compress) {
                try compressor.close();
                compressor.reset(main_buffer_writer);
            }

            file_content_markers[index] = .{ .start = content_start_index, .end = buffer.items.len };
        }

        content.buffer = try buffer.toOwnedSlice();

        for (file_content_markers, 0..) |marker, index| {
            content.file_info[index].content = content.buffer[marker.start..marker.end];
        }

        return content;
    }

    fn deinit(content: *StaticContent, allocator: Allocator) void {
        for (&content.file_info) |*info| {
            info.deinit();
        }
        allocator.free(content.buffer);
    }
};

var static_content: StaticContent = undefined;

const ServerContext = struct {
    allocator: Allocator,
};

pub fn main() anyerror!void {
    const port = 8080;
    var localhost = try std.net.Address.parseIp("0.0.0.0", port);

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();

    const allocator = gpa.allocator();

    var context = ServerContext{ .allocator = allocator };
    var server = try TortieServer(ServerContext).init(allocator, localhost, context, handleRequest);

    static_content = try StaticContent.init(allocator, &static_files);
    log.info("{d:.3}Mb of static content loaded", .{@as(f32, @floatFromInt(static_content.buffer.len)) / (1024 * 1024)});

    log.info("Listening on port {}", .{port});
    log.debug("Build is single threaded: {}", .{builtin.single_threaded});

    while (true) {
        server.run() catch {};
    }
}

fn handleRequest(client: *tortie.Client, context: ServerContext) !void {
    handleRequestError(client, context) catch |err| {
        const status: tortie.Response.ResponseStatus = if (err == error.NotFound) .not_found else .internal_server_error;
        if (status == .not_found) {
            log.warn("Requested path \"{s}\" not found", .{client.buffers.request().getPath() catch "unknown"});
        }
        try client.buffers.responseWriter().writeStatus(status);
    };
}

fn handleRequestError(client: *tortie.Client, context: ServerContext) !void {
    const request_path = client.buffers.request().getPath() catch blk: {
        log.warn("Could not parse path, defaulting to /", .{});
        break :blk "/";
    };

    log.info("Handling request {s}", .{request_path});

    for (static_content.file_info) |*info| {
        if (std.mem.eql(u8, request_path, info.path)) {
            try serveStaticFile(client, context.allocator, info);
            return;
        }
    }

    return error.NotFound;
}

fn serveStaticFile(client: *tortie.Client, allocator: Allocator, options: *StaticFile) !void {
    const content = blk: {
        if (builtin.mode == .Debug or options.content == null) {
            break :blk try options.loadContent(allocator);
        }

        break :blk options.content orelse return error.NotFound;
    };

    var response = client.buffers.responseWriter();

    try response.writeStatus(.ok);
    try response.writeHeader("Content-Type", options.content_type);
    try response.writeHeader("Content-Length", content.len);

    if (client.keep_alive) {
        try response.writeHeader("Connection", "keep-alive");
        try response.writeHeader("Keep-Alive", "timeout=5");
    }

    if (options.secure_context) {
        try response.writeHeader("Cross-Origin-Opener-Policy", "same-origin");
        try response.writeHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }

    if (options.compress) {
        try response.writeHeader("Content-Encoding", "deflate");
    }

    try response.writeBody(content);
}

fn getMimeType(file_name: []const u8) []const u8 {
    if (std.mem.endsWith(u8, file_name, ".css")) {
        return "text/css";
    } else if (std.mem.endsWith(u8, file_name, ".wasm")) {
        return "application/wasm";
    } else if (std.mem.endsWith(u8, file_name, ".js")) {
        return "application/javascript";
    } else if (std.mem.endsWith(u8, file_name, ".ico")) {
        return "image/png";
    } else if (std.mem.endsWith(u8, file_name, ".html")) {
        return "text/html";
    } else {
        return "text/plain";
    }
}
