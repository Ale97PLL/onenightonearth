const std = @import("std");
const math = std.math;
/// A radian-to-degree converter specialized for longitude values.
/// If the resulting degree value would be greater than 180 degrees,
/// 360 degrees will be subtracted - meaning that this function returns
/// values in a range of [-180, 180] degrees.
const rad_to_deg_constant = 180.0 / math.pi;
const deg_to_rad_constant = math.pi / 180.0;

pub const Point = packed struct {
    x: f32,
    y: f32,

    pub fn getDist(self: Point, other: Point) f32 {
        return std.math.sqrt(std.math.pow(f32, self.x - other.x, 2.0) + std.math.pow(f32, self.y - other.y, 2.0));
    }
};

pub const Line = struct {
    a: Point,
    b: Point,

    pub fn getSlope(self: Line) f32 {
        return (self.b.y - self.a.y) / (self.b.x - self.a.x);
    }

    pub fn getYIntercept(self: Line) f32 {
        return self.a.y - (self.getSlope() * self.a.x);
    }

    /// Return `true` if the given point lies on the line defined by the points `a` and `b`.
    pub fn containsPoint(self: Line, p: Point) bool {
        return floatEq((self.b.x - self.a.x) * (p.y - self.a.y), (p.x - self.a.x) * (self.b.y - self.a.y), 0.005);
    }

    /// Return `true` if the given point lies on the line segment defined by the points
    /// `a` and `b`.
    pub fn segmentContainsPoint(self: Line, point: Point) bool {
        if (!self.containsPoint(point)) return false;

        const min_x = math.min(self.a.x, self.b.x);
        const max_x = math.max(self.a.x, self.b.x);
        if (point.x < min_x or point.x > max_x) return false;

        const min_y = math.min(self.a.y, self.b.y);
        const max_y = math.max(self.a.y, self.b.y);
        if (point.y < min_y or point.y > max_y) return false;

        return true;
    }

    /// Find the point of intersection between two lines. The two lines extend
    /// into infinity.
    pub fn intersection(self: Line, other: Line) ?Point {
        const self_slope = self.getSlope();
        const other_slope = other.getSlope();

        if (floatEq(self_slope, other_slope, 0.005)) {
            return null;
        }

        const a = self.a.y - (self_slope * self.a.x);
        const b = other.a.y - (other_slope * other.a.x);

        const x = (a - b) / (other_slope - self_slope);
        const y = ((self_slope * (a - b)) / (other_slope - self_slope)) + a;

        return Point{ .x = x, .y = y };
    }

    /// Find the point of intersection within the segments defined by the two lines.
    /// The segments have ends at points `a` and `b` for each line.
    pub fn segmentIntersection(self: Line, other: Line) ?Point {
        const inter_point = self.intersection(other);
        if (inter_point) |point| {
            if (self.segmentContainsPoint(point) and other.segmentContainsPoint(point)) {
                return point;
            }
        }

        return null;
    }
};

pub fn radToDegLong(radian: anytype) @TypeOf(radian) {
    const deg = radToDeg(radian);
    if (deg > 180.0) {
        return deg - 360.0;
    } else if (deg < -180.0) {
        return deg + 360.0;
    } else {
        return deg;
    }
}

/// A standard radian-to-degree conversion function.
pub fn radToDeg(radian: anytype) @TypeOf(radian) {
    return radian * rad_to_deg_constant;
}

/// A standard degree-to-radian conversion function.
pub fn degToRad(degrees: anytype) @TypeOf(degrees) {
    return degrees * deg_to_rad_constant;
}

pub fn degToRadLong(degrees: anytype) @TypeOf(degrees) {
    const norm_deg = if (degrees < 0) degrees + 360 else degrees;
    return degToRad(norm_deg);
}


pub const OperationError = error{NaN};

/// Safely perform acos on a value without worrying about the value being outside of the range [-1.0, 1.0]. The value
/// will be clamped to either end depending on whether it's too high or too low.
pub fn boundedACos(x: anytype) OperationError!@TypeOf(x) {
    const T = @TypeOf(x);
    const value = switch (T) {
        f32, f64 =>  math.acos(x),
        f128, comptime_float => return math.acos(@floatCast(f64, x)),
        else => @compileError("boundedACos not implemented for type " ++ @typeName(T)),
    };

    return if (std.math.isNan(value)) error.NaN else value;
}

pub fn boundedASin(x: anytype) OperationError!@TypeOf(x) {
    const T = @TypeOf(x);
    const value = switch (T) {
        f32, f64 => math.asin(x),
        f128, comptime_float => math.asin(@floatCast(f64, x)),
        else => @compileError("boundedACos not implemented for type " ++ @typeName(T)),
    };

    return if (std.math.isNan(value)) error.NaN else value;
}

fn FloatModResult(comptime input_type: type) type {
    return switch (@typeInfo(input_type)) {
        .ComptimeFloat => f128,
        .Float => input_type,
        else => @compileError("floatMod is not implemented for type " ++ @typeName(input_type))
    };
}

pub fn floatMod(num: anytype, denom: @TypeOf(num)) FloatModResult(@TypeOf(num)) {
    const T = @TypeOf(num);
    // comptime_float is not compatable with math.fabs, so cast to f128 before using
    const numerator = if (T == comptime_float) @floatCast(f128, num) else num;
    const denominator = if (T == comptime_float) @floatCast(f128, denom) else denom;

    const div = math.floor(math.absFloat(numerator / denominator));
    const whole_part = math.absFloat(denominator) * div;

    return if (num < 0) num + whole_part else num - whole_part;
}

pub fn floatEq(a: anytype, b: @TypeOf(a), epsilon: f32) bool {
    return -epsilon <= a - b and a - b <= epsilon;
}

test "degree to radian conversion" {
    const epsilon = 0.001;
    const degree = 45.0;
    const radian = degToRad(degree);
    std.testing.expectWithinEpsilon(math.pi / 4.0, radian, epsilon);
}

test "radian to degree conversion" {
    const epsilon = 0.001;
    const degree = comptime radToDeg(math.pi / 4.0);
    std.testing.expectWithinEpsilon(45.0, degree, epsilon);
}

test "custom float modulus" {
    const margin = 0.0001;
    std.testing.expectEqual(1.0, comptime floatMod(4.0, 1.5));
    std.testing.expectWithinMargin(1.3467, comptime floatMod(74.17405, 14.56547), margin);
    std.testing.expectWithinMargin(1.3467, comptime floatMod(74.17405, -14.56547), margin);
    std.testing.expectWithinMargin(-1.3467, comptime floatMod(-74.17405, -14.56547), margin);
    std.testing.expectWithinMargin(-1.3467, comptime floatMod(-74.17405, 14.56547), margin);
}

test "longitude back and forth conversion - negative" {
    const epsilon = 0.001;
    const degLong = -75.0;
    const radLong = comptime degToRad(degLong);
    const backDegLong = comptime radToDegLong(radLong);
    std.testing.expectWithinEpsilon(-degLong, -backDegLong, epsilon);
}

test "line intersection" {
    const line_a = Line{
        .a = Point{ .x = 234, .y = 129 },
        .b = Point{ .x = 345, .y = 430 }
    };
    const line_b = Line{
        .a = Point{ .x = 293, .y = 185 },
        .b = Point{ .x = 481, .y = 512 }
    };

    const inter_point = line_a.intersection(line_b);
    std.testing.expectWithinMargin(@as(f32, 186.05), inter_point.?.x, 0.01);
    std.testing.expectWithinMargin(@as(f32, -1.02), inter_point.?.y, 0.01);
    std.testing.expect(line_a.containsPoint(inter_point.?));
    std.testing.expect(line_b.containsPoint(inter_point.?));

    const seg_inter = line_a.segmentIntersection(line_b);
    std.testing.expect(seg_inter == null);
}

test "segment intersect" {
    const line_a = Line{
        .a = Point{ .x = 234, .y = 129 },
        .b = Point{ .x = 345, .y = 430 }
    };
    const line_b = Line{
        .a = Point{ .x = 241, .y = 201 },
        .b = Point{ .x = 299, .y = 105 }
    };

    const inter_point = line_a.intersection(line_b);
    std.testing.expectWithinMargin(@as(f32, 253.14), inter_point.?.x, 0.01);
    std.testing.expectWithinMargin(@as(f32, 180.9), inter_point.?.y, 0.01);

    const seg_inter_point = line_a.segmentIntersection(line_b);
    std.testing.expectWithinMargin(@as(f32, 253.14), seg_inter_point.?.x, 0.01);
    std.testing.expectWithinMargin(@as(f32, 180.9), seg_inter_point.?.y, 0.01);
}