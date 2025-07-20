module.exports = {
    timeout: 60000,
    recursive: true,
    require: [
        'source-map-support/register'
    ],
    reporter: 'spec',
    colors: true,
    // UI tests can take longer
    slow: 5000,
    // Exit after tests complete
    exit: true
}; 