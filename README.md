# Fast-Downloader
A jank way of downloading files faster by splitting files into chunks and downloading each chunk concurrently with its own thread. Doing it this way has a higher chance of fully saturating bandwidth and can also sometimes bypass speed limits. Having a high speed internet connection is highly recommended.

# How to use
1. Install nodejs
2. Clone this repo
3. Run `npm install`
4. Run `node server.js`
5. Go to [http://localhost:3000/](http://localhost:3000/) and start downloading