FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first
# This helps Docker cache the dependencies layer if package.json hasn't changed
COPY package*.json ./

# Install production dependencies
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

EXPOSE 3001

# Start the application
CMD ["node", "app.js"]
