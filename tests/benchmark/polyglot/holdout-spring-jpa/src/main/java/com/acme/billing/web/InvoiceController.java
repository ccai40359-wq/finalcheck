package com.acme.billing.web;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import javax.persistence.EntityManager;
import javax.persistence.Query;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/invoices")
public class InvoiceController {

    private final EntityManager em;
    private final Path storageRoot = Paths.get("/srv/invoices");

    public InvoiceController(EntityManager em) {
        this.em = em;
    }

    @GetMapping
    public List<?> list(@RequestParam(name = "customer") String customer) {
        Query q = em.createNativeQuery("SELECT * FROM invoice WHERE customer = '" + customer + "'"); // EXPECT: S2 sqli
        return q.getResultList();
    }

    @GetMapping("/safe")
    public List<?> listSafe(@RequestParam(name = "customer") String customer) {
        Query q = em.createNativeQuery("SELECT * FROM invoice WHERE customer = :c"); // SAFE: S2
        q.setParameter("c", customer);
        return q.getResultList();
    }

    @GetMapping("/jpql")
    public List<?> jpql(@RequestParam String sort) {
        return em.createQuery("SELECT i FROM Invoice i ORDER BY i." + sort).getResultList(); // EXPECT: S2 sqli
    }

    @GetMapping("/{id}/pdf")
    public byte[] pdf(@PathVariable("id") String id) throws IOException {
        Path file = storageRoot.resolve(id + ".pdf"); // EXPECT: S2 path
        return Files.readAllBytes(file);
    }

    @GetMapping("/{id}/pdf2")
    public byte[] pdfSafe(@PathVariable("id") Long id) throws IOException {
        Path file = storageRoot.resolve(id + ".pdf"); // SAFE: S2
        return Files.readAllBytes(file);
    }

    @PostMapping("/notify")
    public String notifyPartner(@RequestBody NotifyRequest body) throws IOException {
        URL url = new URL(body.callbackUrl); // EXPECT: S2 ssrf
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        return String.valueOf(conn.getResponseCode());
    }

    @GetMapping("/legacy")
    public void legacy(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String q = req.getParameter("q");
        resp.setContentType("text/html");
        resp.getWriter().println("<div>No invoices match " + q + "</div>"); // EXPECT: S2 xss
        String tool = req.getParameter("tool");
        Process p = new ProcessBuilder("sh", "-c", "invoice-" + tool).start(); // EXPECT: S2 cmd
        resp.getWriter().println("<div>started</div>"); // SAFE: S2
    }

    @GetMapping("/login-redirect")
    public String afterLogin(@RequestParam String next) {
        return "redirect:" + next; // EXPECT: S2 open-redirect
    }

    @GetMapping("/home")
    public String home() {
        return "redirect:/invoices"; // SAFE: S2
    }

    public static class NotifyRequest {
        public String callbackUrl;
    }
}
