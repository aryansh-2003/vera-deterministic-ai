import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'


const app = express()


app.use(cors({
    origin: [process.env.CORS_ORIGIN ,process.env.UPTIME_URI],
    credentials: true
}))




app.use(express.json({limit:"16kb"}))
app.use(express.urlencoded({extended: true, limit:'16kb'}))
app.use(express.static("public"))
app.use(cookieParser())


// routes import

import veraRouter from './routes/vera.routes.js'



//routes declaration 

app.use("/v1", veraRouter)


export { app } 