var fs = require('fs');
var path = require('path');
var url = require('url');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var utils = require('./util.js');

// Third party modules
var mime = require('mime');
var mkdirp = require('mkdirp');
var _ = require('underscore');
var srs = require('srs');
var get = require('get');
var zipfile = require('zipfile');
var Step = require('step');

var path_sep;
if (process.platform = "win32") {
    path_sep = '\\';
} else {
    path_sep = '/';
}

// Known SRS values
var SRS = {
    'WGS84': '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs',
    '900913': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 ' +
        '+y_0=0.0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over'
};

// on object of locks for concurrent downloads
var downloads = {};
var pool = require('generic-pool').Pool({
    create: function(callback) {
        callback(null, {});
    },
    destroy: function(obj) {
        obj = undefined;
    },
    max: 5
});

function download(l, filepath, callback) {
    var url = l.Datasource.file;
    var dl = filepath + '.download';
    // If this file is already being downloaded, attach the callback
    // to the existing EventEmitter
    if (downloads[url]) {
        return downloads[url].once('done', callback);
    } else {
        downloads[url] = new EventEmitter();
        pool.acquire(function(obj) {
            pool.release(obj);
            (new get(url)).toDisk(dl, function(err, file, response, g) {
                if (err) {
                    downloads[url].emit('done', err);
                    delete downloads[url];
                    return callback(err);
                }
                fs.rename(dl, filepath, function(err) {
                    // We store the headers from the download in a hidden file
                    // alongside the data for future reference. Currently, we
                    // only use the `content-disposition` header to determine
                    // what kind of file we downloaded if it doesn't have an
                    // extension.
                    fs.writeFile(metapath(filepath), JSON.stringify(response.headers), 'utf-8', function(err) {
                        downloads[url].emit('done', err, filepath);
                        delete downloads[url];
                        return callback(err, filepath);
                    });
                });
            });
        });
    }
}

// Generate the cache path for a given URL.
function cachepath(location) {
    var uri = url.parse(location);
    if (!uri.protocol) {
        throw new Error('Invalid URL: ' + location);
    } else {
        var hash = crypto.createHash('md5')
            .update(location)
            .digest('hex')
            .substr(0,8) +
            '-' + path.basename(uri.pathname, path.extname(uri.pathname));
        var extname = path.extname(uri.pathname);
        return _(['.shp', '.zip']).include(extname.toLowerCase()) ?
            path.join(hash, hash + extname)
            : path.join(hash + extname);
    }
}

// Determine the path for a files dotfile.
function metapath(filepath) {
    return path.join(path.dirname(filepath), '.' + path.basename(filepath));
}

function guessExtension(headers) {
    if (headers['content-disposition']) {
        // Taken from node-get
        var match = headers['content-disposition'].match(/filename=['"]?([^'";]+)['"]?/);
        if (match) {
            var ext = path.extname(match[1]);
            if (ext) {
                return ext;
            }
        }
    } else if (headers['content-type']) {
        var ext = mime.extension(headers['content-type'].split(';')[0]);
        if (ext) {
            return '.' + ext;
        }
    }
    return false;
};

// Unzip function, geared specifically toward unpacking a shapefile.
function unzip(file, callback) {
    var zf;
    try {
        zf = new zipfile.ZipFile(file);
    } catch (err) {
        return callback(err);
    }

    var remaining = zf.names.length;
    var shp = _(zf.names).chain()
        .map(function(name) {
            if (path.extname(name).toLowerCase() !== '.shp') return;
            return path.join(
                path.dirname(file),
                path.basename(file, path.extname(file)) +
                path.extname(name).toLowerCase()
            );
        })
        .compact()
        .first()
        .value();

    if (!shp) return callback(new Error('Shapefile not found in zip ' + file));

    zf.names.forEach(function(name) {
        // Skip directories, hiddens.
        if (!path.extname(name) || name[0] === '.') {
            remaining--;
            if (!remaining) callback(null, shp);
        }
        // We're brutal in our expectations -- don't support nested
        // directories, and rename any file from `arbitraryName.SHP`
        // to `[hash].shp`.
        var dest = path.join(
            path.dirname(file),
            path.basename(file, path.extname(file)) +
            path.extname(name).toLowerCase()
        );
        zf.readFile(name, function(err, buff) {
            if (err) return callback(err);
            fs.open(dest, 'w', 0644, function(err, fd) {
                if (err) return callback(err);
                fs.write(fd, buff, 0, buff.length, null, function(err) {
                    if (err) return callback(err);
                    fs.close(fd, function(err) {
                        if (err) return callback(err);
                        remaining--;
                        if (!remaining) callback(null, shp);
                    });
                });
            });
        });
    });
}

// Fix known bad SRS strings to good ones.
function fixSRS(obj) {
    if (!obj.srs) return;

    var normalized = _(obj.srs.split(' ')).chain()
        .select(function(s) { return s.indexOf('=') > 0; })
        .sortBy(function(s) { return s; })
        .reduce(function(memo, s) {
            var key = s.split('=')[0];
            var val = s.split('=')[1];
            if (val === '0') val = '0.0';
            memo[key] = val;
            return memo;
        }, {})
        .value();
    var legacy = {
        '+a': '6378137',
        '+b': '6378137',
        '+lat_ts': '0.0',
        '+lon_0': '0.0',
        '+proj': 'merc',
        '+units': 'm',
        '+x_0': '0.0',
        '+y_0': '0.0'
    };
    if (!_(legacy).chain()
        .reject(function(v, k) { return normalized[k] === v; })
        .size()
        .value()) obj.srs = SRS['900913'];
}

// Resolve and process all externals for an MML file.
function resolve(options, callback) {
    if (typeof callback !== 'function') throw new Error('Second argument must be a callback');
    if (!options) return callback(new Error('options is required'));
    if (!options.mml) return callback(new Error('options.mml is required'));
    if (!options.base) return callback(new Error('options.base is required'));
    if (!options.cache) return callback(new Error('options.cache is required'));

    var mml = options.mml,
        base = path.resolve(options.base),
        cache = path.resolve(options.cache),
        resolved = JSON.parse(JSON.stringify(mml));

    Step(function setup() {
        mkdirp(path.join(base, 'layers'), 0755, this);
    }, function externals(err) {
        if (err && err.code !== 'EEXIST') throw err;

        var remaining = mml.Layer.length + mml.Stylesheet.length;
        var error = null;
        var next = function(err) {
            remaining--;
            if (err && err.code !== 'EEXIST') error = err;
            if (!remaining) this(error);
        }.bind(this);

        if (!remaining) return this();

        resolved.Stylesheet.forEach(function(s, index) {
            if (typeof s !== 'string') return next();
            var uri = url.parse(s);

            // URL, download.
            if (uri.protocol) {
                return (new get(s)).asBuffer(function(err, data) {
                    if (err) return next(err);

                    resolved.Stylesheet[index] = {
                        id: path.basename(uri.pathname),
                        data: data.toString()
                    };
                    next(err);
                });
            }

            // File, read from disk.
            if (uri.pathname[0] !== '/') {
                uri.pathname = path.join(base, uri.pathname);
            }
            fs.readFile(uri.pathname, 'utf8', function(err, data) {
                if (err) return next(err);

                resolved.Stylesheet[index] = {
                    id: s,
                    data: data
                };
                next(err);
            });
        });

        resolved.Layer.forEach(function(l, index) {
            if (!l.Datasource || !l.Datasource.file) return next();

            var name = l.name || 'layer-' + index,
                uri = url.parse(encodeURI(l.Datasource.file)),
                pathname = decodeURI(uri.pathname),
                extname = path.extname(pathname);

            // This function takes (egregious) advantage of scope;
            // l, extname, and more is all up-one-level.
            //
            // `file`: filename to be symlinked in place to l.Datasource.file
            var symlink = function(file) {
                if (!file) return next();

                switch (extname.toLowerCase()) {
                // Unzip and symlink to directory.
                case '.zip':
                    l.Datasource.file =
                        path.join(base,
                            'layers',
                            name,
                            path.basename(file, path.extname(file)) + '.shp');
                    path.exists(l.Datasource.file, function(exists) {
                        if (exists) return next();
                        unzip(file, function(err, file) {
                            if (err) return next(err);
                            utils.forcelink(path.dirname(file),
                                path.dirname(l.Datasource.file),
                                next);
                        });
                    });
                    break;
                // Symlink directories
                case '.shp':
                    l.Datasource.file =
                        path.join(base, 'layers', name, path.basename(file));
                    utils.forcelink(
                        path.dirname(file),
                        path.dirname(l.Datasource.file), next);
                    break;
                // Symlink files
                default:
                    l.Datasource.file =
                        path.join(base, 'layers', name + extname);
                    utils.forcelink(
                        file,
                        l.Datasource.file,
                        next);
                    break;
                }
            };

            // URL.
            if (uri.protocol) {
                var filepath = path.join(cache, cachepath(l.Datasource.file));
                path.exists(filepath, function(exists) {
                    if (exists) {
                        symlink(filepath);
                    } else {
                        mkdirp(path.dirname(filepath), 0755, function(err) {
                            if (err && err.code !== 'EEXIST') {
                                next(err);
                            } else {
                                download(l, filepath, function(err, filepath) {
                                    if (err) return next(err);
                                    symlink(filepath);
                                });
                            }
                        });
                    }
                });
            // Absolute path.
            } else if (pathname && pathname[0] === '/') {
                symlink(pathname);
            // Local path.
            } else {
                l.Datasource.file = path.resolve(path.join(base, pathname));
                next();
            }
        });
    }, function processSql(err) {
        if (err) throw err;
        var group = this.group();
        resolved.Layer.forEach(function(l, index) {
            var d = l.Datasource;
            // mapnik's sqlite plugin resolves attached databases
            // relative to the main database, but in tilemill we prefer
            // to interpret relative to the project so we resolve here
            if (d.type == 'sqlite' && d.table && d.attachdb) {
                var next = group();
                var dbs = d.attachdb.split(',');
                Step(function() {
                    var group = this.group();
                    for (i = 0; i < dbs.length; i++) (function(next) {
                        if (!dbs[i]) {
                            return next();
                        }

                        var file = dbs[i].split('@').pop();
                        if (file[0] != '/') {
                            file = path.resolve(path.join(base, file));
                            dbs[i] = dbs[i].split('@').shift() + '@' + file;
                        }
                        next();
                        
                    })(group());
                }, function(err) {
                    if (err) throw err;
                    d.attachdb = dbs.join(',');
                    return next(err);
                });
            }
        });
    }, function autodetect(err) {
        if (err) throw err;

        var group = this.group();
        resolved.Layer.forEach(function(l, index) {
            var d = l.Datasource;
            var next = group();

            Step(function() {
                var ext = path.extname(d.file);
                var next = this;
                if (ext) {
                    next(null, ext);
                } else {
                    // This file doesn't have an extension, so we look for a
                    // hidden metadata file that will contain headers for the
                    // original HTTP request. We looks at the
                    // `content-disposition` header to determine the extension.
                    fs.readlink(l.Datasource.file, function(err, resolvedPath) {
                        var metafile = metapath(resolvedPath);
                        path.exists(metafile , function(exists) {
                            if (!exists) return next(new Error('Metadata file does not exist.'));
                            fs.readFile(metafile, 'utf-8', function(err, data) {
                                if (err) return next(err);
                                try {
                                    ext = guessExtension(JSON.parse(data));
                                    next(null, ext);
                                } catch (e) {
                                    next(e);
                                }
                            });
                        });
                    });
                }
            }, function(err, ext) {
                // Ignore errors during extension checks above and let a
                // missing extension fall through to a missing `type`.

                var name = l.name || 'layer-' + index;

                var ext = ext || path.extname(d.file);
                switch (ext) {
                case '.csv':
                case '.tsv': // google refine uses tsv for tab-delimited
                case '.txt': // resonable assumption that .txt is csv?
                    d.quiet = d.quiet || true; // Supress verbose mapnik error reporting by default.
                    d.type = d.type || 'csv';
                    l.srs = l.srs || SRS.WGS84;
                    break;
                case '.shp':
                case '.zip':
                    d.type = d.type || 'shape';
                    break;
                case '.geotiff':
                case '.geotif':
                case '.vrt':
                case '.tiff':
                case '.tif':
                    d.type = d.type || 'gdal';
                    break;
                case '.geojson':
                case '.json':
                    d.type = d.type || 'ogr';
                    d.layer_by_index = 0;
                    l.srs = l.srs || srs.parse(d.file).proj4;
                    break;
                case '.kml':
                case '.rss':
                    d.type = d.type || 'ogr';
                    d.layer_by_index = 0;
                    // WGS84 is the only valid SRS for KML and RSS so we force
                    // it here.
                    l.srs = SRS.WGS84;
                    break;
                }

                if (l.srs) return next();

                var error = new Error('Unable to determine SRS for layer "' + name + '" at ' + d.file);
                if (d.type !== 'shape') {
                    // If we don't have a projection by now, bail out unless we have a shapefile.
                    return next(error);
                } else {
                    // Special handling that opens .prj files for shapefiles.
                    var prj_path = path.join(
                        path.dirname(d.file),
                        path.basename(d.file, path.extname(d.file)) + '.prj'
                    );
                    fs.readFile(prj_path, 'utf8', function(err, data) {
                        if (err && err.code === 'ENOENT') {
                            return next(error);
                        } else if (err) {
                            return next(err);
                        }

                        try {
                            l.srs = l.srs || srs.parse(data).proj4;
                            l.srs = l.srs || srs.parse('ESRI::' + data).proj4; // See issue #26.
                        } catch (e) {
                            next(e);
                        }

                        next(l.srs ? null : error);
                    });
                }
            });
        });
    }, function end(err) {
        // Fix map & layer SRS values.
        resolved.srs = resolved.srs || SRS['900913'];
        fixSRS(resolved);
        resolved.Layer.forEach(fixSRS);

        callback(err, resolved);
    });
}

// Flush the cache for a given layer/url.
function flush(options, callback) {
    if (!options) return callback(new Error('options is required'));
    if (!options.base) return callback(new Error('options.base is required'));
    if (!options.cache) return callback(new Error('options.cache is required'));
    if (!options.layer) return callback(new Error('options.layer is required'));
    if (!options.url) return callback(new Error('options.url is required'));

    var uri = url.parse(options.url);
    if (!uri.protocol) return callback(new Error('Invalid URL: ' + options.url));

    var extname = path.extname(path.basename(uri.pathname));
    var filepath;
    var layerpath;

    switch (extname.toLowerCase()) {
    case '.zip':
    case '.shp':
        layerpath = path.join(options.base, 'layers', options.layer);
        filepath = path.join(options.cache, path.dirname(cachepath(options.url)));
        break;
    default:
        layerpath = path.join(options.base, 'layers', options.layer + extname);
        filepath = path.join(options.cache, cachepath(options.url));
        break;
    }

    Step(function() {
        fs.lstat(layerpath, this);
    }, function removeSymlink(err, stat) {
        if (err && err.code !== 'ENOENT') throw err;
        if (!err && stat.isSymbolicLink()) {
            fs.unlink(layerpath, this);
        } else {
            this();
        }
    }, function removeCache(err) {
        if (err) throw err;
        path.exists(filepath, function(exists) {
            if (!exists) return this();
            utils.rm(filepath, this);
        }.bind(this));
    }, function removeMetafile(err) {
        if (err) throw err;
        path.exists(metapath(filepath), function(exists) {
            if (!exists) return this();
            utils.rm(metapath(filepath), this);
        }.bind(this));
    }, function finish(err) {
        callback(err);
    });
}

module.exports = {
    resolve: resolve,
    flush: flush
};

