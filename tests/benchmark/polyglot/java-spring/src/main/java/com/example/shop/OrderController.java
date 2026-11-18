package com.example.shop;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.commons.io.FilenameUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

@RestController
@RequestMapping("/api")
public class OrderController {
    private final JdbcTemplate jdbc;
    private final Connection conn;
    private final RestTemplate rest = new RestTemplate();

    public OrderController(JdbcTemplate jdbc, Connection conn) {
        this.jdbc = jdbc;
        this.conn = conn;
    }

    @GetMapping("/orders")
    public List<Map<String, Object>> orders(@RequestParam String status) {
        return jdbc.queryForList("SELECT * FROM orders WHERE status = '" + status + "'"); // EXPECT: S2 sqli
    }

    @GetMapping("/orders/safe")
    public List<Map<String, Object>> ordersSafe(@RequestParam("status") String status) {
        return jdbc.queryForList("SELECT * FROM orders WHERE status = ?", status); // SAFE: S2
    }

    @GetMapping("/users/{id}")
    public String user(@PathVariable String id) throws Exception {
        Statement st = conn.createStatement();
        ResultSet rs = st.executeQuery("SELECT name FROM users WHERE id = " + id); // EXPECT: S2 sqli
        PreparedStatement ps = conn.prepareStatement("SELECT name FROM users WHERE id = ?"); // SAFE: S2
        ps.setString(1, id);
        return rs.getString(1);
    }

    @GetMapping("/report")
    public void report(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String name = req.getParameter("name");
        resp.getWriter().write("<h1>Report for " + name + "</h1>"); // EXPECT: S2 xss
        String file = req.getParameter("file");
        InputStream in = new FileInputStream("/var/reports/" + file); // EXPECT: S2 path
        in.close();
        String base = FilenameUtils.getName(file);
        InputStream in2 = new FileInputStream(new File("/var/reports", base)); // SAFE: S2
        in2.close();
    }

    @PostMapping("/convert")
    public String convert(@RequestParam String fmt) throws IOException {
        Process p = Runtime.getRuntime().exec("convert input.png output." + fmt); // EXPECT: S2 cmd
        Process q = new ProcessBuilder("convert", "input.png", "output.png").start(); // SAFE: S2
        return "ok";
    }

    @GetMapping("/proxy")
    public String proxy(@RequestParam String url) {
        return rest.getForObject(url, String.class); // EXPECT: S2 ssrf
    }

    @GetMapping("/proxy/item")
    public String proxyItem(@RequestParam String id) {
        return rest.getForObject("https://catalog.internal.example.com/items/" + id, String.class); // SAFE: S2
    }

    @GetMapping("/go")
    public void go(@RequestParam String next, HttpServletResponse resp) throws IOException {
        resp.sendRedirect(next); // EXPECT: S2 open-redirect
    }

    @PostMapping("/import")
    public Object importData(HttpServletRequest req) throws Exception {
        ObjectInputStream ois = new ObjectInputStream(req.getInputStream());
        return ois.readObject(); // EXPECT: S2 deserialization
    }

    @PostMapping("/xml")
    public String xml(HttpServletRequest req) throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance(); // EXPECT: S2 xxe
        DocumentBuilder b = dbf.newDocumentBuilder();
        return b.parse(req.getInputStream()).getDocumentElement().getTextContent();
    }

    @PostMapping("/xml/safe")
    public String xmlSafe(HttpServletRequest req) throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance(); // SAFE: S2
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        DocumentBuilder b = dbf.newDocumentBuilder();
        return b.parse(req.getInputStream()).getDocumentElement().getTextContent();
    }

    @PostMapping("/register")
    public String register(@RequestParam String password) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5"); // EXPECT: S8 weak-hash
        byte[] hash = md.digest(password.getBytes());
        MessageDigest sha = MessageDigest.getInstance("SHA-256"); // SAFE: S8
        return new String(hash);
    }
}
