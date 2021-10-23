import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

enum SpectralType {
    O = 0,
    B = 1,
    A = 2,
    F = 3,
    G = 4,
    K = 5,
    M = 6,
}

type SkyFile = Record<string, string>;

interface Star {
    name: string;
    right_ascension: number;
    declination: number;
    brightness: number;
    spec_type: SpectralType;
}

interface SkyCoord {
    right_ascension: number;
    declination: number;
}

interface Constellation {
    name: string;
    epithet: string;
    asterism: SkyCoord[];
    boundaries: SkyCoord[];
    is_zodiac: boolean;
}

const PORT = 8080;
const HOST = process.env['HOST'] ?? '127.0.0.1';
const app = express();

app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.json());

const readFile = (path: string): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (error, data) => {
            if (error != null) {
                reject(error);
            }
            resolve(data);
        });
    });
};

const stat = (path: string): Promise<fs.Stats> => {
    return new Promise((resolve, reject) => {
        fs.stat(path, (err, stats) => {
            if (err != null) {
                reject(err);
            }
            resolve(stats);
        });
    });
};

/**
 * Get a list of all the filenames in the top level of a directory.
 * @param dir_path The path to the directory to read
 */
const readDir = (dir_path: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        fs.readdir(dir_path, async (err, files) => {
            if (err != null) {
                reject(err);
            }
            const filenames: string[] = [];
            for (const name of files) {
                const full_path = path.join(dir_path, name);
                const stats = await stat(full_path);
                if (!stats.isDirectory()) {
                    filenames.push(full_path);
                }
            }
            resolve(filenames);
        });
    });
};

const parseSkyFile = (data: string): SkyFile => {
    const fields: SkyFile = {};
    const lines = data.includes('\r\n') ? data.split('\r\n') : data.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const current_line = lines[i];
        if (current_line.startsWith('@')) {
            if (current_line.includes('=') && !current_line.includes('=|')) {
                const [field_name, field_value] = current_line
                    .substring(1)
                    .split('=')
                    .map(s => s.trim());
                fields[field_name] = field_value;
            } else if (current_line.includes('=|')) {
                // Get each line after this as a multiline string
                // Keep going until the next new symbol
                const field_name = current_line.substring(1).split('=|')[0].trim();
                let field_value = '';
                i += 1;
                while (i < lines.length && !lines[i].startsWith('@') && !lines[i].startsWith('#')) {
                    field_value = field_value.concat('\n', lines[i]);
                    i += 1;
                }
                fields[field_name] = field_value;
                i -= 1;
            }
        } else if (current_line.startsWith('#')) {
            const field_name = current_line.substring(1);
            fields[field_name] = 'true';
        }
    }
    return fields;
};

const readConstellationFiles = async (): Promise<Constellation[]> => {
    const sky_files = await readDir(path.join(__dirname, 'parse-data', 'constellations', 'iau'));
    const result: Constellation[] = [];
    for (const filename of sky_files) {
        const file = await readFile(filename);
        const data = parseSkyFile(file.toString());
        const const_name = data['name'];

        console.log(const_name);

        const stars = data['stars']
            .split('\n')
            .map(s => s.trim())
            .filter(s => s != null && s !== '')
            .map(star_data => {
                const [name, ra_data, dec_data] = star_data.split(',').map(s => s.trim());
                return {
                    name,
                    right_ascension: parseFloat(ra_data),
                    declination: parseFloat(dec_data),
                };
            });
        const asterism: SkyCoord[] = data['asterism']
            ?.split('\n')
            .map(s => s.trim())
            .filter(s => s != null && s !== '')
            .flatMap(aster_line => {
                const star_names = aster_line.split(',').map(a => a.trim());
                const [star_a, star_b] = star_names.map(name => stars.find(star => star.name === name));
                if (star_a != null && star_b != null) {
                    return [
                        {
                            right_ascension: star_a.right_ascension,
                            declination: star_a.declination,
                        },
                        {
                            right_ascension: star_b.right_ascension,
                            declination: star_b.declination,
                        },
                    ];
                } else {
                    return null;
                }
            })
            .filter(coord => coord != null) as SkyCoord[];
        const boundaries: SkyCoord[] = data['boundaries']
            .split('\n')
            .map(s => s.trim())
            .filter(s => s != null && s !== '')
            .map(boundary_data => {
                const [ra_data, dec_data] = boundary_data.split(',').map(b => b.trim());
                return {
                    right_ascension: parseRightAscension(ra_data),
                    declination: parseFloat(dec_data),
                };
            });

        result.push({
            name: const_name,
            epithet: data['epithet'],
            asterism,
            boundaries,
            is_zodiac: data['zodiac'] === 'true',
        });
    }

    return result;
};

const parseCatalogLine = (line: string): Star | null => {
    const data_values = line.split('|');
    let result: Star = {
        name: '',
        right_ascension: 0,
        declination: 0,
        brightness: 0,
        spec_type: 0,
    };
    let current_entry = 0;
    for (const entry of data_values) {
        if (current_entry > 14) break;
        switch (current_entry) {
            case 0:
                result.name = entry;
                break;
            case 1:
                try {
                    result.right_ascension = parseFloat(entry);
                } catch (err) {
                    return null;
                }
                break;
            case 5:
                try {
                    result.declination = parseFloat(entry);
                } catch (err) {
                    return null;
                }
                break;
            case 13:
                try {
                    const v_mag = parseFloat(entry);
                    const dimmest_visible = 18.6;
                    const brightest_value = -4.6;
                    const mag_display_factor = (dimmest_visible - (v_mag - brightest_value)) / dimmest_visible;
                    result.brightness = mag_display_factor;
                } catch (err) {
                    return null;
                }
                break;
            case 14:
                const type = entry.charAt(0).toLowerCase();
                if (type === 'o') {
                    result.spec_type = SpectralType.O;
                } else if (type === 'b') {
                    result.spec_type = SpectralType.B;
                } else if (type === 'a') {
                    result.spec_type = SpectralType.A;
                } else if (type === 'f') {
                    result.spec_type = SpectralType.F;
                } else if (type === 'g') {
                    result.spec_type = SpectralType.G;
                } else if (type === 'k') {
                    result.spec_type = SpectralType.K;
                } else if (type === 'm') {
                    result.spec_type = SpectralType.M;
                } else {
                    // Default to white for now, probably should update later
                    result.spec_type = SpectralType.A;
                }
                break;
        }
        current_entry += 1;
    }

    return result;
};

const parseRightAscension = (ra: string): number => {
    const parts = ra.split(' ');
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parseFloat(parts[2]);

    const hours_deg = hours * 15;
    const minutes_deg = (minutes / 60) * 15;
    const seconds_deg = (seconds / 3600) * 15;

    return hours_deg + minutes_deg + seconds_deg;
};

const main = async () => {
    // const star_parse_start = performance.now();
    // const stars: Star[] = await readFile(path.join(__dirname, 'parse-data', 'sao_catalog'))
    //     .then(catalog =>
    //         catalog
    //             .toString()
    //             .split('\n')
    //             .filter(line => line.startsWith('SAO'))
    //     )
    //     .then(lines => lines.map(parseCatalogLine).filter(star => star != null) as Star[]);
    // const star_parse_end = performance.now();

    // const bright_stars = stars.filter(star => star.brightness > 0.3);
    // console.log(`There are ${bright_stars.length} stars`);

    // console.log(`Star parsing took ${star_parse_end - star_parse_start} ms`);
    const star_bin = await readFile(path.join(__dirname, 'parse-data', 'star_data.bin'));

    const const_parse_start = performance.now();
    const constellations: Constellation[] = await readConstellationFiles();
    const const_parse_end = performance.now();

    console.log(`Constellation parsing took ${const_parse_end - const_parse_start} ms`);
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.get('/stars', (req, res) => {
        const response_start = performance.now();
        // const brightness_param = (req.query.brightness as string) ?? '0.3';
        // const min_brightness = parseFloat(brightness_param);
        // res.send(stars.filter(star => star.brightness >= min_brightness));
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': star_bin.buffer.byteLength,
        });

        console.log(`Content-Length is ${star_bin.buffer.byteLength / 1024} kB, or ${star_bin.buffer.byteLength / 13} stars`);
        res.write(star_bin);
        res.end();
        const response_end = performance.now();
        console.log(`Sending stars took ${response_end - response_start} ms`);
    });

    app.get('/constellations', (req, res) => {
        res.send(constellations);
    });

    http.createServer(app).listen(PORT, HOST, () => console.log(`Listening on port ${PORT}`));
};

main();
